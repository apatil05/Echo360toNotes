-- Initial schema for the hosted Echo360 Notes app.
--
-- Every table is owned by a student (user_id -> auth.users) and protected by
-- row-level security, so the browser can query Supabase directly and only ever
-- sees its own rows. The AWS Lambda worker connects with the service role,
-- which bypasses RLS.
--
-- API keys never live in these tables: the key is stored encrypted in Supabase
-- Vault and api_keys holds only a reference plus a display hint. Students write
-- keys through set_api_key(); only the service role can read them back.

create extension if not exists supabase_vault with schema vault;

-- ─── Helpers ─────────────────────────────────────────────────────────────────

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ─── profiles ────────────────────────────────────────────────────────────────

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 80),
  -- Notes are dated in the student's timezone, like the local server does.
  timezone text not null default 'UTC',
  -- Get Started flow: which steps are done (e.g. {"api_key": true, "extension": true}).
  onboarding jsonb not null default '{}'::jsonb,
  default_notes_provider text,
  default_notes_model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Create a profile for every new sign-up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─── api_keys ────────────────────────────────────────────────────────────────

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('groq', 'nebius', 'openai', 'openrouter', 'ollama', 'custom')),
  -- Only for provider = 'custom' (any OpenAI-compatible server).
  base_url text check (base_url is null or base_url ~ '^https://'),
  -- Last 4 characters, shown in Settings as "gsk_…a3f9". Never the key itself.
  key_hint text not null check (char_length(key_hint) <= 8),
  vault_secret_id uuid not null unique,
  validated_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider),
  check ((provider = 'custom') = (base_url is not null))
);

create trigger api_keys_updated_at
  before update on public.api_keys
  for each row execute function public.set_updated_at();

-- Removing a key row (directly or through account deletion) destroys the secret.
create or replace function public.delete_api_key_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets where id = old.vault_secret_id;
  return old;
end;
$$;

create trigger api_keys_delete_secret
  after delete on public.api_keys
  for each row execute function public.delete_api_key_secret();

-- Stores or replaces the caller's key for a provider. Returns the api_keys row id.
create or replace function public.set_api_key(p_provider text, p_key text, p_base_url text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  existing public.api_keys;
  secret_id uuid;
  key_id uuid;
  trimmed text := btrim(p_key);
begin
  if uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if trimmed is null or char_length(trimmed) < 8 or char_length(trimmed) > 512 then
    raise exception 'API key looks invalid' using errcode = '22023';
  end if;

  select * into existing from public.api_keys where user_id = uid and provider = p_provider;

  if found then
    perform vault.update_secret(existing.vault_secret_id, trimmed);
    update public.api_keys
       set key_hint = right(trimmed, 4),
           base_url = p_base_url,
           validated_at = null
     where id = existing.id
     returning id into key_id;
  else
    secret_id := vault.create_secret(trimmed, 'api_key:' || uid || ':' || p_provider, 'Student API key');
    insert into public.api_keys (user_id, provider, base_url, key_hint, vault_secret_id)
    values (uid, p_provider, p_base_url, right(trimmed, 4), secret_id)
    returning id into key_id;
  end if;

  return key_id;
end;
$$;

-- For the Lambda worker only: decrypts a key and stamps last_used_at.
create or replace function public.get_api_key_secret(p_key_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  secret text;
begin
  select ds.decrypted_secret into secret
    from public.api_keys k
    join vault.decrypted_secrets ds on ds.id = k.vault_secret_id
   where k.id = p_key_id;

  if secret is null then
    raise exception 'API key not found' using errcode = 'P0002';
  end if;

  update public.api_keys set last_used_at = now() where id = p_key_id;
  return secret;
end;
$$;

revoke all on function public.set_api_key(text, text, text) from public, anon;
grant execute on function public.set_api_key(text, text, text) to authenticated;
revoke all on function public.get_api_key_secret(uuid) from public, anon, authenticated;
grant execute on function public.get_api_key_secret(uuid) to service_role;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.delete_api_key_secret() from public, anon, authenticated;

-- ─── courses ─────────────────────────────────────────────────────────────────

create table public.courses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  code text not null check (char_length(code) between 1 and 40),  -- e.g. CS383
  name text check (char_length(name) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index courses_user_code_key on public.courses (user_id, lower(code));

create trigger courses_updated_at
  before update on public.courses
  for each row execute function public.set_updated_at();

-- ─── lectures ────────────────────────────────────────────────────────────────

create table public.lectures (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  course_id uuid references public.courses (id) on delete set null,
  topic text check (char_length(topic) <= 200),
  -- Echo360 identifies a lesson by the id in /lesson/<id>/ and the host it lives on.
  echo360_host text,
  echo360_lesson_id text,
  lecture_date date not null default current_date,
  duration_seconds integer check (duration_seconds >= 0),
  has_captions boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((echo360_host is null) = (echo360_lesson_id is null))
);

-- Re-running a lecture reuses its row instead of creating a duplicate.
create unique index lectures_user_lesson_key
  on public.lectures (user_id, echo360_host, echo360_lesson_id)
  where echo360_lesson_id is not null;
create index lectures_user_date_idx on public.lectures (user_id, lecture_date desc);
create index lectures_course_idx on public.lectures (course_id);

create trigger lectures_updated_at
  before update on public.lectures
  for each row execute function public.set_updated_at();

-- ─── jobs ────────────────────────────────────────────────────────────────────
-- One row per generation attempt (runner = 'browser' for captions, 'lambda'
-- for uploaded audio).

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  lecture_id uuid not null references public.lectures (id) on delete cascade,
  source text not null check (source in ('captions', 'audio', 'transcript_file', 'media_file')),
  runner text not null check (runner in ('browser', 'lambda')),
  status text not null default 'queued'
    check (status in ('queued', 'uploading', 'transcribing', 'generating', 'succeeded', 'failed', 'canceled')),
  progress smallint not null default 0 check (progress between 0 and 100),
  status_detail text check (char_length(status_detail) <= 500),
  api_key_id uuid references public.api_keys (id) on delete set null,
  notes_provider text,
  notes_model text,
  transcribe_model text,
  chunks_total smallint check (chunks_total >= 0),
  chunks_done smallint not null default 0 check (chunks_done >= 0),
  -- Uncaptioned lectures: where the extension uploaded the audio (S3 key, not a URL).
  audio_object_key text,
  audio_bytes bigint check (audio_bytes >= 0),
  -- Optional slides PDF in the 'slides' storage bucket.
  slides_path text,
  error_code text,
  error_message text check (char_length(error_message) <= 2000),
  attempts smallint not null default 0,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (runner = 'lambda' or source <> 'audio'),
  check ((status in ('succeeded', 'failed', 'canceled')) = (finished_at is not null))
);

create index jobs_user_created_idx on public.jobs (user_id, created_at desc);
create index jobs_lecture_idx on public.jobs (lecture_id);
create index jobs_api_key_idx on public.jobs (api_key_id);
-- The worker's "what's still running" scan.
create index jobs_active_idx on public.jobs (status, updated_at)
  where status in ('queued', 'uploading', 'transcribing', 'generating');

create trigger jobs_updated_at
  before update on public.jobs
  for each row execute function public.set_updated_at();

-- ─── notes ───────────────────────────────────────────────────────────────────

create table public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  lecture_id uuid not null references public.lectures (id) on delete cascade,
  job_id uuid references public.jobs (id) on delete set null,
  title text not null check (char_length(title) between 1 and 300),
  body_md text not null,
  word_count integer not null default 0 check (word_count >= 0),
  -- Raw transcript in the 'transcripts' storage bucket, so a lecture never has
  -- to be transcribed twice.
  transcript_path text,
  search tsvector generated always as (
    setweight(to_tsvector('english', title), 'A') || setweight(to_tsvector('english', body_md), 'B')
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index notes_user_created_idx on public.notes (user_id, created_at desc);
create index notes_lecture_idx on public.notes (lecture_id);
create index notes_job_idx on public.notes (job_id);
create index notes_search_idx on public.notes using gin (search);

create trigger notes_updated_at
  before update on public.notes
  for each row execute function public.set_updated_at();

-- ─── destinations & exports ──────────────────────────────────────────────────
-- Optional places notes are copied to. The app's own notes table is always the
-- source of truth.

create table public.destinations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('obsidian', 'google_drive', 'local_folder')),
  label text not null check (char_length(label) between 1 and 80),
  -- Non-secret settings only (folder path, subfolder layout). OAuth tokens go in Vault.
  config jsonb not null default '{}'::jsonb,
  vault_secret_id uuid unique,
  auto_export boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index destinations_user_idx on public.destinations (user_id);

create trigger destinations_updated_at
  before update on public.destinations
  for each row execute function public.set_updated_at();

create or replace function public.delete_destination_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.vault_secret_id is not null then
    delete from vault.secrets where id = old.vault_secret_id;
  end if;
  return old;
end;
$$;

revoke all on function public.delete_destination_secret() from public, anon, authenticated;

create trigger destinations_delete_secret
  after delete on public.destinations
  for each row execute function public.delete_destination_secret();

create table public.note_exports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  note_id uuid not null references public.notes (id) on delete cascade,
  destination_id uuid not null references public.destinations (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'exported', 'failed')),
  -- Where it landed: a vault-relative path, a Drive file id, ...
  external_ref text,
  error_message text check (char_length(error_message) <= 2000),
  exported_at timestamptz,
  created_at timestamptz not null default now(),
  unique (note_id, destination_id)
);

create index note_exports_user_idx on public.note_exports (user_id);
create index note_exports_destination_idx on public.note_exports (destination_id);

-- ─── Row-level security ──────────────────────────────────────────────────────
-- (select auth.uid()) is evaluated once per statement instead of once per row.

alter table public.profiles enable row level security;
alter table public.api_keys enable row level security;
alter table public.courses enable row level security;
alter table public.lectures enable row level security;
alter table public.jobs enable row level security;
alter table public.notes enable row level security;
alter table public.destinations enable row level security;
alter table public.note_exports enable row level security;

create policy "own profile: read" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy "own profile: update" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Keys: read the hint and delete only. Writes go through set_api_key().
create policy "own keys: read" on public.api_keys
  for select to authenticated using (user_id = (select auth.uid()));
create policy "own keys: delete" on public.api_keys
  for delete to authenticated using (user_id = (select auth.uid()));

create policy "own courses" on public.courses
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "own lectures" on public.lectures
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and (course_id is null or exists (select 1 from public.courses c where c.id = course_id and c.user_id = (select auth.uid())))
  );

create policy "own jobs: read" on public.jobs
  for select to authenticated using (user_id = (select auth.uid()));
create policy "own jobs: create" on public.jobs
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and status = 'queued'
    and exists (select 1 from public.lectures l where l.id = lecture_id and l.user_id = (select auth.uid()))
    and (api_key_id is null or exists (select 1 from public.api_keys k where k.id = api_key_id and k.user_id = (select auth.uid())))
  );
-- The browser reports progress for jobs it runs itself; Lambda jobs are
-- updated only by the worker (service role).
create policy "own browser jobs: update" on public.jobs
  for update to authenticated
  using (user_id = (select auth.uid()) and runner = 'browser')
  with check (user_id = (select auth.uid()) and runner = 'browser');

create policy "own notes" on public.notes
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.lectures l where l.id = lecture_id and l.user_id = (select auth.uid()))
    and (job_id is null or exists (select 1 from public.jobs j where j.id = job_id and j.user_id = (select auth.uid())))
  );

create policy "own destinations" on public.destinations
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy "own exports" on public.note_exports
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.notes n where n.id = note_id and n.user_id = (select auth.uid()))
    and exists (select 1 from public.destinations d where d.id = destination_id and d.user_id = (select auth.uid()))
  );

-- ─── Table privileges ────────────────────────────────────────────────────────
-- Spelled out in full, so access is the same whether or not the project
-- auto-exposes new tables to the Data API. Privileges decide which tables and
-- columns a role may touch at all; the policies above decide which rows.
-- Anonymous visitors get nothing: every feature needs an account.

revoke all on public.profiles, public.api_keys, public.courses, public.lectures,
              public.jobs, public.notes, public.destinations, public.note_exports
  from anon, authenticated;

grant all on public.profiles, public.api_keys, public.courses, public.lectures,
             public.jobs, public.notes, public.destinations, public.note_exports
  to service_role;

grant select on public.profiles to authenticated;
grant update (display_name, timezone, onboarding, default_notes_provider, default_notes_model)
  on public.profiles to authenticated;

-- Key rows are written only by set_api_key(); students may view hints and delete.
grant select, delete on public.api_keys to authenticated;

grant select, insert, update, delete on public.courses, public.lectures, public.notes, public.note_exports
  to authenticated;

-- A student can't move a job to another runner, lecture, or key, or fake attempts.
grant select, insert on public.jobs to authenticated;
grant update (status, progress, status_detail, notes_provider, notes_model, transcribe_model,
              chunks_total, chunks_done, slides_path, error_code, error_message, started_at, finished_at)
  on public.jobs to authenticated;

-- vault_secret_id is set only by server-side OAuth code (service role).
grant select, delete on public.destinations to authenticated;
grant insert (user_id, kind, label, config, auto_export) on public.destinations to authenticated;
grant update (label, config, auto_export) on public.destinations to authenticated;

-- ─── Storage ─────────────────────────────────────────────────────────────────
-- Private buckets; objects live under "<user_id>/...".

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('slides', 'slides', false, 50 * 1024 * 1024, array['application/pdf']),
  ('transcripts', 'transcripts', false, 10 * 1024 * 1024, array['text/plain', 'text/vtt'])
on conflict (id) do nothing;

create policy "own files: read" on storage.objects
  for select to authenticated
  using (bucket_id in ('slides', 'transcripts') and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own files: upload" on storage.objects
  for insert to authenticated
  with check (bucket_id in ('slides', 'transcripts') and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "own files: delete" on storage.objects
  for delete to authenticated
  using (bucket_id in ('slides', 'transcripts') and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ─── Realtime ────────────────────────────────────────────────────────────────
-- The dashboard subscribes to its own job rows for live progress (RLS applies).

alter publication supabase_realtime add table public.jobs;
