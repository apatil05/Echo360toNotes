-- Row-level security and key-handling tests. Run with `supabase test db`.
begin;
-- `supabase test db --linked` connects as a temporary login role without
-- access to the extensions schema; run as postgres, as local tests do.
set local role postgres;
set local search_path = public, extensions;
create extension if not exists pgtap with schema extensions;
select plan(47);

-- Two students.
insert into auth.users (id, email, raw_user_meta_data) values
  ('11111111-1111-1111-1111-111111111111', 'alice@example.edu', '{"full_name": "Alice"}'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.edu', '{}');

select is((select display_name from public.profiles where id = '11111111-1111-1111-1111-111111111111'),
  'Alice', 'sign-up creates a profile');

-- ── Act as Alice ────────────────────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims = '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';

select lives_ok($$ select public.set_api_key('groq', 'gsk_alice_secret_key_a3f9') $$, 'Alice can save a key');
select is((select key_hint from public.api_keys), 'a3f9', 'only the last 4 characters are visible');
select is((select count(*)::int from public.api_keys where key_hint like '%secret%'), 0, 'the key text is not in api_keys');
select throws_ok($$ select public.get_api_key_secret((select id from public.api_keys limit 1)) $$,
  '42501', null, 'students cannot decrypt keys, even their own');
select throws_ok($$ update public.api_keys set vault_secret_id = gen_random_uuid() $$,
  '42501', null, 'students cannot repoint a key row at another secret');
select throws_ok($$ select public.set_api_key('groq', 'short') $$, '22023', null, 'implausible keys are rejected');

insert into public.courses (id, user_id, code) values ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'CS383');
select throws_ok($$ insert into public.courses (user_id, code) values ('11111111-1111-1111-1111-111111111111', 'cs383') $$,
  '23505', null, 'course codes are unique per student, ignoring case');

insert into public.lectures (id, user_id, course_id, topic, echo360_host, echo360_lesson_id)
values ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
        'aaaaaaaa-0000-0000-0000-000000000001', 'Sorting', 'echo360.org', 'lesson-1');

insert into public.jobs (id, user_id, lecture_id, source, runner, api_key_id) values
  ('aaaaaaaa-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000002',
   'captions', 'browser', (select id from public.api_keys limit 1)),
  ('aaaaaaaa-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000002',
   'audio', 'lambda', (select id from public.api_keys limit 1));

select throws_ok($$ insert into public.jobs (user_id, lecture_id, source, runner)
                    values ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000002', 'audio', 'browser') $$,
  '23514', null, 'audio jobs must run on Lambda');
select throws_ok($$ insert into public.jobs (user_id, lecture_id, source, runner, status)
                    values ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000002', 'captions', 'browser', 'succeeded') $$,
  '42501', null, 'new jobs must start queued');

update public.jobs set status = 'generating', progress = 40 where id = 'aaaaaaaa-0000-0000-0000-000000000003';
select is((select progress::int from public.jobs where id = 'aaaaaaaa-0000-0000-0000-000000000003'), 40,
  'the browser can report progress on its own job');
update public.jobs set status = 'failed', finished_at = now() where id = 'aaaaaaaa-0000-0000-0000-000000000004';
select is((select status from public.jobs where id = 'aaaaaaaa-0000-0000-0000-000000000004'), 'queued',
  'the browser cannot change a Lambda job');
select throws_ok($$ update public.jobs set runner = 'lambda' where id = 'aaaaaaaa-0000-0000-0000-000000000003' $$,
  '42501', null, 'the runner column is not client-writable');

insert into public.notes (user_id, lecture_id, job_id, title, body_md) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000003',
   'Sorting Algorithms', 'Merge sort splits the deck in half. Comparison sorts have an n log n lower bound.');
select is((select count(*)::int from public.notes where search @@ websearch_to_tsquery('english', 'merge sorting')), 1,
  'full-text search finds notes by stemmed words');

select throws_ok($$ insert into public.destinations (user_id, kind, label, vault_secret_id)
                    values ('11111111-1111-1111-1111-111111111111', 'google_drive', 'Drive', gen_random_uuid()) $$,
  '42501', null, 'students cannot attach a secret to a destination');

select lives_ok($$ insert into storage.objects (bucket_id, name) values ('slides', '11111111-1111-1111-1111-111111111111/week1.pdf') $$,
  'Alice can upload into her own storage folder');
select throws_ok($$ insert into storage.objects (bucket_id, name) values ('slides', '22222222-2222-2222-2222-222222222222/week1.pdf') $$,
  '42501', null, 'Alice cannot upload into Bob''s storage folder');

-- ── Act as Bob ──────────────────────────────────────────────────────────────
set local request.jwt.claims = '{"sub": "22222222-2222-2222-2222-222222222222", "role": "authenticated"}';

select is((select count(*)::int from public.api_keys) + (select count(*)::int from public.jobs)
        + (select count(*)::int from public.notes) + (select count(*)::int from public.lectures), 0,
  'Bob sees none of Alice''s rows');
select is((select count(*)::int from public.profiles), 1, 'Bob sees only his own profile');
select throws_ok($$ insert into public.jobs (user_id, lecture_id, source, runner)
                    values ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000002', 'captions', 'browser') $$,
  '42501', null, 'Bob cannot start a job on Alice''s lecture');
select throws_ok($$ insert into public.lectures (user_id, course_id) values ('22222222-2222-2222-2222-222222222222', 'aaaaaaaa-0000-0000-0000-000000000001') $$,
  '42501', null, 'Bob cannot file a lecture under Alice''s course');
delete from public.notes;
update public.jobs set progress = 99;

-- ── Anonymous visitors ──────────────────────────────────────────────────────
set local role anon;
set local request.jwt.claims = '{"role": "anon"}';
select throws_ok($$ select public.set_api_key('groq', 'gsk_anonymous_key_123') $$, '42501', null, 'anonymous visitors cannot save keys');

-- ── The Lambda worker (service role) ────────────────────────────────────────
set local role postgres;
set local role service_role;
select is((select count(*)::int from public.notes where user_id = '11111111-1111-1111-1111-111111111111'), 1, 'Bob''s delete did not touch Alice''s notes');
select is((select progress::int from public.jobs where id = 'aaaaaaaa-0000-0000-0000-000000000003'), 40, 'Bob''s update did not touch Alice''s job');
select is(public.get_api_key_secret((select id from public.api_keys where user_id = '11111111-1111-1111-1111-111111111111' limit 1)), 'gsk_alice_secret_key_a3f9',
  'the worker can decrypt the key');

-- Replacing then deleting a key keeps Vault tidy.
set local role postgres;
set local role authenticated;
set local request.jwt.claims = '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated"}';
select lives_ok($$ select public.set_api_key('groq', 'gsk_alice_rotated_key_b7c2') $$, 'Alice can replace her key');
set local role postgres;
select is((select decrypted_secret from vault.decrypted_secrets ds join public.api_keys k on k.vault_secret_id = ds.id where k.user_id = '11111111-1111-1111-1111-111111111111'),
  'gsk_alice_rotated_key_b7c2', 'replacing a key updates the same secret');

delete from auth.users where id = '11111111-1111-1111-1111-111111111111';
select is((select count(*)::int from vault.secrets where name like 'api_key:11111111%'), 0,
  'deleting an account destroys the student''s secrets');

-- ── Worker job state (migration 2) ──────────────────────────────────────────
insert into auth.users (id, email) values ('33333333-3333-3333-3333-333333333333', 'cara@example.edu');
insert into public.lectures (id, user_id) values ('cccccccc-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333');
set local role authenticated;
set local request.jwt.claims = '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}';
select throws_ok($$ insert into public.jobs (user_id, lecture_id, source, runner, checkpoint)
                    values ('33333333-3333-3333-3333-333333333333', 'cccccccc-0000-0000-0000-000000000001', 'captions', 'browser', '{"parts": ["fake"]}') $$,
  '42501', null, 'students cannot seed worker-owned fields');
select throws_ok($$ insert into public.jobs (user_id, lecture_id, source, runner)
                    values ('33333333-3333-3333-3333-333333333333', 'cccccccc-0000-0000-0000-000000000001', 'media_file', 'browser') $$,
  '23514', null, 'uploaded recordings must run on Lambda');
insert into public.jobs (id, user_id, lecture_id, source, runner)
values ('cccccccc-0000-0000-0000-000000000002', '33333333-3333-3333-3333-333333333333', 'cccccccc-0000-0000-0000-000000000001', 'media_file', 'lambda');
select throws_ok($$ select * from public.claim_job('cccccccc-0000-0000-0000-000000000002', 60) $$,
  '42501', null, 'students cannot claim jobs');

set local role postgres;
set local role service_role;
select is((select count(*)::int from public.claim_job('cccccccc-0000-0000-0000-000000000002', 60)), 1, 'the worker can lease a job');
select is((select count(*)::int from public.claim_job('cccccccc-0000-0000-0000-000000000002', 60)), 0, 'a leased job cannot be claimed twice');
set local role postgres;

-- ── Table privileges (independent of the Data API auto-expose setting) ─────
select is((select count(*)::int from information_schema.role_table_grants
            where table_schema = 'public' and grantee = 'anon'), 0,
  'anonymous visitors have no privileges on any app table');
select is((select count(*)::int from information_schema.role_table_grants
            where table_schema = 'public' and grantee = 'authenticated' and privilege_type = 'TRUNCATE'), 0,
  'students cannot truncate tables');
set local role anon;
select throws_ok($$ select count(*) from public.notes $$, '42501', null, 'anonymous reads are refused outright');
set local role postgres;
set local role authenticated;
set local request.jwt.claims = '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated"}';
select throws_ok($$ update public.profiles set id = gen_random_uuid() $$, '42501', null, 'students cannot change their profile id');
set local role postgres;

-- ── Dashboard support (migration 4) ─────────────────────────────────────────
insert into public.notes (user_id, lecture_id, title, body_md)
values ('33333333-3333-3333-3333-333333333333', 'cccccccc-0000-0000-0000-000000000001', 'Outline probe',
        E'# Title\n\n## Big Picture\n- x\n\n## Core Idea: Sorting *(MOST IMPORTANT)*\ntext\n### Sub\n## Key Terms');
select is((select outline from public.notes where title = 'Outline probe'),
  array['Big Picture', 'Core Idea: Sorting', 'Key Terms'], 'note outline lists ## sections without markers');

set local role authenticated;
set local request.jwt.claims = '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated", "session_id": "dddddddd-0000-0000-0000-000000000001"}';
select public.set_api_key('openai', 'sk-cara-tested-key-1234', null, true);
select ok((select validated_at is not null from public.api_keys where provider = 'openai'),
  'a tested key records when it was checked');
select lives_ok($$ select public.register_extension_link('Chrome on macOS', '1.2.0') $$, 'the extension registers its browser');
select is((select count(*)::int from public.extension_links), 1, 'the student sees their linked browser');
select throws_ok($$ insert into public.extension_links (user_id, session_id, label) values ('33333333-3333-3333-3333-333333333333', gen_random_uuid(), 'x') $$,
  '42501', null, 'links are only created through the register function');

set local request.jwt.claims = '{"sub": "22222222-2222-2222-2222-222222222222", "role": "authenticated", "session_id": "dddddddd-0000-0000-0000-000000000001"}';
select throws_ok($$ select public.register_extension_link('Hijack', null) $$, '42501', null, 'another account cannot take over a linked session');
select throws_ok($$ select public.unlink_extension((select id from public.extension_links limit 1)) $$,
  'P0002', null, 'another account cannot unlink it');

set local request.jwt.claims = '{"sub": "33333333-3333-3333-3333-333333333333", "role": "authenticated", "session_id": "dddddddd-0000-0000-0000-000000000001"}';
select lives_ok($$ select public.unlink_extension((select id from public.extension_links limit 1)) $$, 'the owner can unlink the browser');
set local role postgres;

-- ── Course colours (migration 5) ────────────────────────────────────────────
insert into public.courses (user_id, code)
select '33333333-3333-3333-3333-333333333333', 'C' || n from generate_series(1, 9) n;
select is((select count(distinct color)::int from public.courses
            where user_id = '33333333-3333-3333-3333-333333333333' and code in ('C1','C2','C3','C4','C5','C6','C7','C8')),
  8, 'the first eight courses get eight different colours, even in one insert');
select is((select color from public.courses where user_id = '33333333-3333-3333-3333-333333333333' and code = 'C9'),
  'violet', 'colours repeat only after all eight are used');

select * from finish();
rollback;
