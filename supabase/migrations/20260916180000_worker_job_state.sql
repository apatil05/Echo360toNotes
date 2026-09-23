-- State the AWS worker needs to run long jobs safely.
--
-- Lambda stops after 15 minutes and SQS may deliver a message twice, so the
-- worker leases a job before touching it (locked_until), saves progress after
-- every notes chunk (checkpoint), and re-queues itself to continue.

alter table public.jobs
  -- Whisper needs a Groq/OpenAI key even when notes use another provider.
  add column transcribe_api_key_id uuid references public.api_keys (id) on delete set null,
  -- Raw transcript in the 'transcripts' bucket, so retries never re-transcribe.
  add column transcript_path text,
  -- {"chunkChars": 12000, "parts": ["...notes for chunk 1..."]}
  add column checkpoint jsonb,
  add column locked_until timestamptz;

create index jobs_transcribe_api_key_idx on public.jobs (transcribe_api_key_id);

-- Uploaded recordings are processed by the worker too, not just captured audio.
alter table public.jobs drop constraint jobs_check;
alter table public.jobs add constraint jobs_media_runs_on_lambda
  check (runner = 'lambda' or source not in ('audio', 'media_file'));
alter table public.jobs rename constraint jobs_check1 to jobs_finished_at_matches_status;

-- One notes row per job, so a retried final step can't create duplicates.
-- A plain constraint (not a partial index) so upserts can target it; notes
-- without a job are still allowed because NULLs never conflict.
alter table public.notes add constraint notes_job_key unique (job_id);
drop index public.notes_job_idx;

-- Clients create jobs with only the fields a student can choose; everything
-- the worker owns must start empty.
drop policy "own jobs: create" on public.jobs;
create policy "own jobs: create" on public.jobs
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and status = 'queued'
    and progress = 0
    and attempts = 0
    and audio_object_key is null
    and transcript_path is null
    and checkpoint is null
    and locked_until is null
    and started_at is null
    and exists (select 1 from public.lectures l where l.id = lecture_id and l.user_id = (select auth.uid()))
    and (api_key_id is null or exists (select 1 from public.api_keys k where k.id = api_key_id and k.user_id = (select auth.uid())))
    and (transcribe_api_key_id is null or exists (select 1 from public.api_keys k where k.id = transcribe_api_key_id and k.user_id = (select auth.uid())))
  );

-- Atomically leases a job for the worker. Returns no row if the job is
-- finished or another invocation holds an unexpired lease.
create or replace function public.claim_job(p_job_id uuid, p_lease_seconds integer)
returns setof public.jobs
language sql
security definer
set search_path = ''
as $$
  update public.jobs
     set locked_until = now() + make_interval(secs => p_lease_seconds),
         started_at = coalesce(started_at, now())
   where id = p_job_id
     and status in ('queued', 'uploading', 'transcribing', 'generating')
     and (locked_until is null or locked_until < now())
  returning *;
$$;

revoke all on function public.claim_job(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_job(uuid, integer) to service_role;
