// Post-deploy check against the real pipeline and hosted Supabase.
//
// Creates a throwaway student with a fake Groq key, uploads 3 s of generated
// audio through the deployed upload URL, and waits for the worker. Groq rejects
// the fake key, so the expected result is a job that FAILS with a 401: that
// proves upload -> S3 event -> SQS -> worker -> Vault -> ffmpeg -> provider all
// ran. The student (and their Vault secret and files) is deleted afterwards.
//
//   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_PUBLISHABLE_KEY=sb_publishable_... \
//   AWS_PROFILE=echo-notes npm run smoke
//
// Needs: ffmpeg on PATH, cdk-outputs.json from `cdk deploy --outputs-file`,
// and AWS credentials that can read the SSM secret.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, ORIGIN = 'http://localhost:5173' } = process.env;
const SECRET_PARAM = process.env.SUPABASE_SERVICE_KEY_PARAM ?? '/echo-notes/supabase-secret-key';
const outputs = JSON.parse(fs.readFileSync(new URL('../cdk-outputs.json', import.meta.url))).EchoNotesPipeline;
if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) throw new Error('Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY');

const step = (msg) => console.log(`• ${msg}`);
const ssm = new SSMClient({ region: 'us-east-1' });
const secret = (await ssm.send(new GetParameterCommand({ Name: SECRET_PARAM, WithDecryption: true }))).Parameter.Value;
const admin = createClient(SUPABASE_URL, secret, { auth: { persistSession: false } });

const email = `smoke-${Date.now()}@example.invalid`;
const password = `Smoke-${crypto.randomUUID()}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-'));
let userId;
let ok = false;

try {
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error) throw created.error;
  userId = created.data.user.id;
  step(`created throwaway student ${userId}`);

  const student = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const session = await student.auth.signInWithPassword({ email, password });
  if (session.error) throw session.error;

  const key = await student.rpc('set_api_key', { p_provider: 'groq', p_key: 'gsk_smoke_test_not_a_real_key_000000' });
  if (key.error) throw key.error;
  const lecture = await student.from('lectures').insert({ user_id: userId, topic: 'Smoke test' }).select().single();
  if (lecture.error) throw lecture.error;
  const job = await student.from('jobs')
    .insert({ user_id: userId, lecture_id: lecture.data.id, source: 'audio', runner: 'lambda', api_key_id: key.data })
    .select().single();
  if (job.error) throw job.error;
  const jobId = job.data.id;
  step(`job ${jobId} created through RLS`);

  const audio = path.join(dir, 'smoke.m4a');
  const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=duration=3', '-c:a', 'aac', audio]);
  if (ff.status !== 0) throw new Error(`ffmpeg failed: ${ff.stderr}`);
  const bytes = fs.readFileSync(audio);

  const res = await fetch(outputs.UploadUrlEndpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.data.session.access_token}`,
      'content-type': 'application/json',
      origin: ORIGIN,
    },
    body: JSON.stringify({ jobId, contentType: 'audio/mp4', size: bytes.length }),
  });
  const form = await res.json();
  if (!res.ok) throw new Error(`upload-url ${res.status}: ${form.error}`);
  step(`upload URL issued (expires in ${form.expiresIn}s)`);

  const body = new FormData();
  for (const [k, v] of Object.entries(form.fields)) body.append(k, v);
  body.append('file', new Blob([bytes], { type: 'audio/mp4' }), 'smoke.m4a');
  const put = await fetch(form.url, { method: 'POST', body });
  if (!put.ok) throw new Error(`S3 upload ${put.status}: ${await put.text()}`);
  step(`uploaded ${bytes.length} bytes to S3`);

  const deadline = Date.now() + 3 * 60_000;
  let last;
  while (Date.now() < deadline) {
    const row = await student.from('jobs').select('status, progress, status_detail, error_code, error_message').eq('id', jobId).single();
    if (row.error) throw row.error;
    const summary = `${row.data.status} ${row.data.progress}% ${row.data.status_detail ?? ''}`.trim();
    if (summary !== last) step(`job: ${summary}`);
    last = summary;
    if (['succeeded', 'failed'].includes(row.data.status)) {
      console.log(`  error_code=${row.data.error_code} message=${(row.data.error_message ?? '').slice(0, 120)}`);
      // Providers label a bad key differently (http_401, invalid_api_key, ...).
      const rejectedKey = row.data.error_code === 'http_401' || /^401\b|invalid.api.key/i.test(`${row.data.error_code} ${row.data.error_message}`);
      if (row.data.status === 'failed' && rejectedKey) {
        ok = true;
        step('PASS: the worker reached the provider with the decrypted key (fake key rejected as expected)');
      } else {
        step('UNEXPECTED result, check the worker logs');
      }
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!last?.match(/^(succeeded|failed)/)) step('TIMED OUT waiting for the worker');
} finally {
  if (userId) {
    const files = await admin.storage.from('transcripts').list(userId);
    if (files.data?.length) await admin.storage.from('transcripts').remove(files.data.map((f) => `${userId}/${f.name}`));
    const del = await admin.auth.admin.deleteUser(userId);
    step(del.error ? `cleanup failed: ${del.error.message}` : 'deleted throwaway student (cascades to their rows and Vault secret)');
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

process.exit(ok ? 0 : 1);
