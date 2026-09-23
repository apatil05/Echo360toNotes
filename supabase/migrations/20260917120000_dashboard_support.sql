-- Support for the web dashboard: note outlines for chapter dots, recording a
-- key test, and linked extension browsers.

-- ─── Note outlines ───────────────────────────────────────────────────────────
-- Section titles (## headings) power the chapter dots in lists and the chapter
-- bar in the reader, without shipping every note body to the library view.

alter table public.notes add column outline text[] not null default '{}';

create or replace function public.set_note_outline()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.outline := coalesce(
    array(
      select btrim(regexp_replace(m[1], '\s*\*\((?:MOST IMPORTANT)\)\*\s*$', '', 'i'))
        from regexp_matches(new.body_md, '^##[ \t]+([^\n]+)$', 'gn') as m
    ),
    '{}'
  );
  return new;
end;
$$;

create trigger notes_set_outline
  before insert or update of body_md on public.notes
  for each row execute function public.set_note_outline();

revoke all on function public.set_note_outline() from public, anon, authenticated;

-- ─── Key tests ───────────────────────────────────────────────────────────────
-- The dashboard tests a key against the provider before saving it. Replace
-- set_api_key with a version that records that result.

drop function public.set_api_key(text, text, text);

create function public.set_api_key(p_provider text, p_key text, p_base_url text default null, p_validated boolean default false)
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
  checked_at timestamptz := case when p_validated then now() end;
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
           validated_at = checked_at
     where id = existing.id
     returning id into key_id;
  else
    secret_id := vault.create_secret(trimmed, 'api_key:' || uid || ':' || p_provider, 'Student API key');
    insert into public.api_keys (user_id, provider, base_url, key_hint, vault_secret_id, validated_at)
    values (uid, p_provider, p_base_url, right(trimmed, 4), secret_id, checked_at)
    returning id into key_id;
  end if;

  return key_id;
end;
$$;

revoke all on function public.set_api_key(text, text, text, boolean) from public, anon;
grant execute on function public.set_api_key(text, text, text, boolean) to authenticated;

-- ─── Linked extension browsers ───────────────────────────────────────────────
-- Each linked Chrome profile has its own Supabase session. The row remembers
-- that session so unlinking also signs the extension out.

create table public.extension_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  session_id uuid not null unique,
  label text not null check (char_length(label) between 1 and 80),  -- e.g. "Chrome on macOS"
  extension_version text check (char_length(extension_version) <= 20),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index extension_links_user_idx on public.extension_links (user_id);

alter table public.extension_links enable row level security;

create policy "own extension links: read" on public.extension_links
  for select to authenticated using (user_id = (select auth.uid()));

revoke all on public.extension_links from anon, authenticated;
grant all on public.extension_links to service_role;
grant select on public.extension_links to authenticated;

-- Called by the extension right after it signs in (and periodically after),
-- using its own session: registers or refreshes this browser.
create or replace function public.register_extension_link(p_label text, p_version text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  sid uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  link_id uuid;
begin
  if uid is null or sid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  insert into public.extension_links (user_id, session_id, label, extension_version)
  values (uid, sid, left(btrim(p_label), 80), left(p_version, 20))
  on conflict (session_id) do update
    set label = excluded.label,
        extension_version = excluded.extension_version,
        last_seen_at = now()
    where public.extension_links.user_id = uid
  returning id into link_id;

  if link_id is null then
    raise exception 'Session belongs to another account' using errcode = '42501';
  end if;
  return link_id;
end;
$$;

-- Called from Settings: removes the link and ends that browser's session.
create or replace function public.unlink_extension(p_link_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  sid uuid;
begin
  if uid is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;

  delete from public.extension_links
   where id = p_link_id and user_id = uid
  returning session_id into sid;

  if sid is null then
    raise exception 'Link not found' using errcode = 'P0002';
  end if;

  delete from auth.sessions where id = sid and user_id = uid;
end;
$$;

revoke all on function public.register_extension_link(text, text) from public, anon;
grant execute on function public.register_extension_link(text, text) to authenticated;
revoke all on function public.unlink_extension(uuid) from public, anon;
grant execute on function public.unlink_extension(uuid) to authenticated;

-- The dashboard shows linked browsers and live job progress.
alter publication supabase_realtime add table public.extension_links;
