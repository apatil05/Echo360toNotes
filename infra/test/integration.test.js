// End-to-end against a local Supabase (`supabase start`): real auth tokens,
// RLS, Vault, storage, and ffmpeg. Only S3 and the model provider are faked.
//
//   npm run test:integration     (fills the env vars from `supabase status`)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';

import { processJob } from '../lambda/lib/processJob.js';
import { createUpload } from '../lambda/lib/uploads.js';
import {
  supabaseAdmin, supabaseRepo, supabaseTokenVerifier, prepareAudio, makeWorkDir, removeWorkDir,
} from '../lambda/lib/services.js';
import { generateNotesResumable } from '../../src/notesGenerator.js';
import { transcribeAudio } from '../../src/transcriber.js';

const { SUPABASE_URL, SUPABASE_SECRET_KEY, SUPABASE_PUBLISHABLE_KEY } = process.env;
const skip = SUPABASE_URL && SUPABASE_SECRET_KEY && SUPABASE_PUBLISHABLE_KEY && spawnSync('ffmpeg', ['-version']).status === 0
  ? false
  : 'needs a local Supabase (npm run test:integration) and ffmpeg';

const API_KEY = 'gsk_integration_test_key_0001';
const email = `worker-it-${Date.now()}@example.edu`;
const password = 'integration-Test-pw-1';

let admin;
let student;
let userId;
let accessToken;
let dir;
let provider;
let providerURL;
const calls = [];

before(async () => {
  if (skip) return;
  admin = supabaseAdmin(SUPABASE_URL, SUPABASE_SECRET_KEY);
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(created.error);
  userId = created.data.user.id;

  student = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const signedIn = await student.auth.signInWithPassword({ email, password });
  assert.ifError(signedIn.error);
  accessToken = signedIn.data.session.access_token;

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-it-'));

  // Fake Groq: Whisper + streaming chat completions.
  provider = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      calls.push({ url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], raw });
      if (req.url.endsWith('/audio/transcriptions')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ text: 'Today we cover merge sort. It splits the list in half.' }));
      }
      const body = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const content = '---\ntags: [cs383]\n---\n# Merge Sort\n\n## Big Picture\n- Divide and conquer';
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((r) => provider.listen(0, '127.0.0.1', r));
  providerURL = `http://127.0.0.1:${provider.address().port}/openai/v1`;
});

after(async () => {
  if (skip) return;
  provider?.close();
  if (userId) {
    const { data } = await admin.storage.from('transcripts').list(userId);
    if (data?.length) await admin.storage.from('transcripts').remove(data.map((f) => `${userId}/${f.name}`));
    await admin.auth.admin.deleteUser(userId);
  }
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('student upload -> worker -> notes the student can read', { skip }, async () => {
  // 1. The student saves a key and creates a lecture + job, through RLS.
  const keyResult = await student.rpc('set_api_key', { p_provider: 'groq', p_key: API_KEY });
  assert.ifError(keyResult.error);
  const keyId = keyResult.data;

  const course = await student.from('courses').insert({ user_id: userId, code: 'CS383' }).select().single();
  assert.ifError(course.error);
  const lecture = await student.from('lectures')
    .insert({ user_id: userId, course_id: course.data.id, topic: 'Sorting', lecture_date: '2026-09-16' }).select().single();
  assert.ifError(lecture.error);
  const job = await student.from('jobs')
    .insert({ user_id: userId, lecture_id: lecture.data.id, source: 'audio', runner: 'lambda', api_key_id: keyId }).select().single();
  assert.ifError(job.error);
  const jobId = job.data.id;

  // 2. The upload API accepts the real Supabase token (verified against local JWKS).
  const repo = supabaseRepo(admin);
  const presigned = [];
  const upload = await createUpload(
    { authorization: `Bearer ${accessToken}`, body: { jobId, contentType: 'audio/mp4', size: 12345 } },
    { verifyToken: supabaseTokenVerifier(SUPABASE_URL), db: repo, presign: async (a) => { presigned.push(a); return { url: 'u', fields: {} }; } },
  );
  assert.equal(presigned[0].key, `uploads/${userId}/${jobId}`);
  assert.equal(upload.expiresIn, 900);

  // 3. A real audio file stands in for the S3 object.
  const audio = path.join(dir, 'lecture.m4a');
  assert.equal(spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=duration=3', '-c:a', 'aac', audio]).status, 0);

  const requeued = [];
  const deleted = [];
  const deps = {
    db: {
      ...repo,
      // Point the student's Groq key at the fake provider; the secret still comes from Vault.
      getApiKey: async (id) => ({ ...(await repo.getApiKey(id)), baseUrl: providerURL }),
    },
    downloadUpload: async (_key, dest) => fs.copyFileSync(audio, dest),
    deleteUpload: async (key) => deleted.push(key),
    requeue: async (id, delay) => requeued.push({ id, delay }),
    prepareAudio,
    makeWorkDir,
    removeWorkDir,
    transcribe: transcribeAudio,
    generateNotes: generateNotesResumable,
    readSlides: async () => null,
    remainingMs: () => 14 * 60_000,
    log: (message, fields) => console.error('[worker]', message, JSON.stringify(fields)),
  };

  // 4. Run the worker.
  assert.deepEqual(await processJob(jobId, deps), { outcome: 'succeeded' });
  assert.deepEqual(await processJob(jobId, deps), { outcome: 'skipped' }, 'a duplicate delivery does nothing');
  assert.deepEqual(requeued, []);
  assert.deepEqual(deleted, [`uploads/${userId}/${jobId}`]);

  // The provider saw the decrypted key and an Opus file.
  const whisper = calls.find((c) => c.url.endsWith('/audio/transcriptions'));
  assert.equal(whisper.auth, `Bearer ${API_KEY}`);
  assert.match(whisper.raw.toString('latin1'), /filename="audio\.opus"[\s\S]*whisper-large-v3/);
  assert.ok(calls.some((c) => c.url.endsWith('/chat/completions') && c.auth === `Bearer ${API_KEY}`));

  // 5. The student sees the finished job, the notes, and the transcript.
  const finished = await student.from('jobs').select('*').eq('id', jobId).single();
  assert.ifError(finished.error);
  assert.equal(finished.data.status, 'succeeded');
  assert.equal(finished.data.progress, 100);
  assert.equal(finished.data.checkpoint, null);
  assert.equal(finished.data.locked_until, null);

  const notes = await student.from('notes').select('*').eq('job_id', jobId);
  assert.ifError(notes.error);
  assert.equal(notes.data.length, 1);
  assert.equal(notes.data[0].title, 'Merge Sort');
  assert.match(notes.data[0].body_md, /Divide and conquer/);

  const transcript = await student.storage.from('transcripts').download(finished.data.transcript_path);
  assert.ifError(transcript.error);
  assert.match(await transcript.data.text(), /merge sort/);

  // The key never shows up in anything the student can read.
  assert.doesNotMatch(JSON.stringify([finished.data, notes.data]), /gsk_integration/);
});

test('extension linking: one-time code, separate session, unlink signs it out', { skip }, async () => {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/link-extension`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, apikey: SUPABASE_PUBLISHABLE_KEY, origin: 'http://localhost:5173' },
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.ok(body.tokenHash);

  // The extension redeems the code for its own session.
  const extension = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const verified = await extension.auth.verifyOtp({ token_hash: body.tokenHash, type: 'email' });
  assert.ifError(verified.error);
  assert.equal(verified.data.user.id, userId);
  assert.notEqual(verified.data.session.refresh_token, undefined);

  const reused = await createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } })
    .auth.verifyOtp({ token_hash: body.tokenHash, type: 'email' });
  assert.ok(reused.error, 'a link code works only once');

  const linked = await extension.rpc('register_extension_link', { p_label: 'Chrome on macOS', p_version: '2.0.0' });
  assert.ifError(linked.error);

  // The web app sees the browser and unlinks it.
  const links = await student.from('extension_links').select('id, label');
  assert.ifError(links.error);
  assert.deepEqual(links.data.map((l) => l.label), ['Chrome on macOS']);
  const unlinked = await student.rpc('unlink_extension', { p_link_id: linked.data });
  assert.ifError(unlinked.error);

  // The extension's session is gone: refreshing fails.
  const refreshed = await extension.auth.refreshSession();
  assert.ok(refreshed.error, 'the unlinked extension can no longer refresh its session');

  // The web app's own session is untouched.
  const still = await student.from('extension_links').select('id');
  assert.ifError(still.error);
  assert.equal(still.data.length, 0);

  const other = await fetch(`${SUPABASE_URL}/functions/v1/link-extension`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, apikey: SUPABASE_PUBLISHABLE_KEY, origin: 'https://evil.example' },
  });
  assert.equal(other.status, 403, 'other origins cannot request link codes');
});
