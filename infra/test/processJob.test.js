import { test } from 'node:test';
import assert from 'node:assert/strict';

import { processJob, PermanentError, classify, scrub, CHUNK_BUDGET_MS, MAX_ATTEMPTS } from '../lambda/lib/processJob.js';

const JOB_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
const GROQ_KEY = 'gsk_test_secret_key_value_1234';

function makeJob(overrides = {}) {
  return {
    id: JOB_ID,
    user_id: USER_ID,
    lecture_id: 'cccccccc-0000-0000-0000-000000000001',
    source: 'audio',
    runner: 'lambda',
    status: 'uploading',
    progress: 0,
    attempts: 0,
    api_key_id: 'key-1',
    transcribe_api_key_id: null,
    notes_provider: null,
    notes_model: null,
    transcribe_model: null,
    audio_object_key: `uploads/${USER_ID}/${JOB_ID}`,
    transcript_path: null,
    slides_path: null,
    checkpoint: null,
    ...overrides,
  };
}

// In-memory stand-ins for Supabase, S3, SQS, ffmpeg, Whisper, and the model.
function harness({ job = makeJob(), keys, notes, transcribe, remainingMs = 14 * 60_000, prepareAudio } = {}) {
  const state = {
    job: job && { ...job },
    updates: [],
    requeued: [],
    deleted: [],
    notes: [],
    transcripts: {},
    workDirs: { made: 0, removed: 0 },
    logs: [],
    generateCalls: [],
  };
  const keyTable = keys ?? { 'key-1': { provider: 'groq', secret: GROQ_KEY } };
  const deps = {
    db: {
      claimJob: async () => (state.job && !['succeeded', 'failed'].includes(state.job.status) ? { ...state.job } : null),
      getLecture: async () => ({ id: 'lec', topic: 'Sorting', lecture_date: '2026-09-16', course_code: 'CS383' }),
      getApiKey: async (id) => keyTable[id] ?? null,
      updateJob: async (_id, fields) => {
        state.updates.push(fields);
        Object.assign(state.job, fields);
      },
      saveTranscript: async (p, text) => { state.transcripts[p] = text; },
      loadTranscript: async (p) => state.transcripts[p],
      upsertNote: async (note) => { state.notes.push(note); },
    },
    downloadUpload: async () => {},
    deleteUpload: async (key) => { state.deleted.push(key); },
    requeue: async (jobId, delaySeconds) => { state.requeued.push({ jobId, delaySeconds }); },
    prepareAudio: prepareAudio ?? (async () => ['/tmp/part-000.opus']),
    makeWorkDir: async () => { state.workDirs.made++; return '/tmp/job'; },
    removeWorkDir: async () => { state.workDirs.removed++; },
    transcribe: transcribe ?? (async () => 'merge sort splits the list in half'),
    generateNotes: async (transcript, llm, meta, options) => {
      state.generateCalls.push({ transcript, llm, meta, options });
      return notes ? notes(options, llm) : { done: true, notes: '# Merge Sort\n\nBody text here', total: 1 };
    },
    readSlides: async () => 'slide text',
    remainingMs: () => remainingMs,
    log: (message, fields) => state.logs.push({ message, ...fields }),
  };
  return { deps, state };
}

test('happy path: transcribes, writes notes, finishes the job, deletes the upload', async () => {
  const { deps, state } = harness();
  const result = await processJob(JOB_ID, deps);

  assert.deepEqual(result, { outcome: 'succeeded' });
  assert.equal(state.transcripts[`${USER_ID}/${JOB_ID}.txt`], 'merge sort splits the list in half');
  assert.equal(state.notes.length, 1);
  assert.deepEqual(
    { title: state.notes[0].title, words: state.notes[0].word_count, transcript: state.notes[0].transcript_path },
    { title: 'Merge Sort', words: 6, transcript: `${USER_ID}/${JOB_ID}.txt` },
  );
  assert.equal(state.job.status, 'succeeded');
  assert.equal(state.job.progress, 100);
  assert.equal(state.job.locked_until, null);
  assert.ok(state.job.finished_at);
  assert.deepEqual(state.deleted, [`uploads/${USER_ID}/${JOB_ID}`]);
  assert.deepEqual(state.workDirs, { made: 1, removed: 1 });

  const [{ llm, meta }] = state.generateCalls;
  assert.equal(llm.provider, 'groq');
  assert.equal(llm.apiKey, GROQ_KEY);
  assert.equal(llm.chunkDelayMs, 62_000); // Groq preset pacing applies
  assert.deepEqual(meta, { course: 'CS383', topic: 'Sorting', slides: null, date: '2026-09-16' });
});

test('an already-transcribed job skips download and Whisper', async () => {
  let transcribed = false;
  const { deps, state } = harness({
    job: makeJob({ transcript_path: 'u/j.txt', status: 'generating' }),
    transcribe: async () => { transcribed = true; return 'x'; },
  });
  state.transcripts['u/j.txt'] = 'saved transcript';
  await processJob(JOB_ID, deps);
  assert.equal(transcribed, false);
  assert.equal(state.workDirs.made, 0);
  assert.equal(state.generateCalls[0].transcript, 'saved transcript');
});

test('out of time mid-notes: saves progress and re-queues after the pacing delay', async () => {
  const { deps, state } = harness({
    job: makeJob({ status: 'generating', transcript_path: 'u/j.txt', progress: 40 }),
    notes: async (options, llm) => {
      await options.onPart(['part one'], 3);
      // 30 s beyond the chunk budget: another chunk fits, but not after a 62 s pause.
      assert.equal(options.canContinue(0), true);
      assert.equal(options.canContinue(62_000), false);
      return { done: false, parts: ['part one'], total: 3, resumeAfterMs: llm.chunkDelayMs };
    },
    remainingMs: CHUNK_BUDGET_MS + 30_000,
  });
  state.transcripts['u/j.txt'] = 'saved transcript';
  const result = await processJob(JOB_ID, deps);

  assert.deepEqual(result, { outcome: 'deferred', delaySeconds: 62 });
  assert.deepEqual(state.requeued, [{ jobId: JOB_ID, delaySeconds: 62 }]);
  assert.deepEqual(state.job.checkpoint, { chunkChars: 12_000, parts: ['part one'] });
  assert.equal(state.job.chunks_done, 1);
  assert.equal(state.job.progress, 58);
  assert.equal(state.job.locked_until, null);
  assert.notEqual(state.job.status, 'succeeded');
  assert.deepEqual(state.deleted, [], 'upload kept until the job finishes');
});

test('a continuation resumes from the checkpoint', async () => {
  const { deps, state } = harness({
    job: makeJob({ status: 'generating', transcript_path: 'u/j.txt', checkpoint: { chunkChars: 12_000, parts: ['a', 'b'] } }),
  });
  state.transcripts['u/j.txt'] = 't';
  await processJob(JOB_ID, deps);
  assert.deepEqual(state.generateCalls[0].options.parts, ['a', 'b']);
});

test('a checkpoint from a different chunk size is discarded', async () => {
  const { deps, state } = harness({
    job: makeJob({ status: 'generating', transcript_path: 'u/j.txt', checkpoint: { chunkChars: 60_000, parts: ['a'] } }),
  });
  state.transcripts['u/j.txt'] = 't';
  await processJob(JOB_ID, deps);
  assert.deepEqual(state.generateCalls[0].options.parts, []);
});

test('too little time to transcribe: hands off to a fresh invocation', async () => {
  const { deps, state } = harness({ remainingMs: 60_000 });
  const result = await processJob(JOB_ID, deps);
  assert.deepEqual(result, { outcome: 'deferred', delaySeconds: 0 });
  assert.deepEqual(state.requeued, [{ jobId: JOB_ID, delaySeconds: 0 }]);
  assert.equal(state.workDirs.made, 0);
});

test('a finished or leased job is skipped', async () => {
  const { deps, state } = harness({ job: makeJob({ status: 'succeeded' }) });
  assert.deepEqual(await processJob(JOB_ID, deps), { outcome: 'skipped' });
  assert.equal(state.updates.length, 0);
});

test('missing key fails permanently with a message the student can act on', async () => {
  const { deps, state } = harness({ keys: {} });
  assert.deepEqual(await processJob(JOB_ID, deps), { outcome: 'failed' });
  assert.equal(state.job.status, 'failed');
  assert.equal(state.job.error_code, 'key_missing');
  assert.match(state.job.error_message, /Add one in Settings/);
  assert.deepEqual(state.requeued, []);
  assert.deepEqual(state.deleted, [`uploads/${USER_ID}/${JOB_ID}`]);
});

test('a notes-only provider key cannot transcribe', async () => {
  const { deps, state } = harness({ keys: { 'key-1': { provider: 'nebius', secret: 'nebius-secret-key-123' } } });
  await processJob(JOB_ID, deps);
  assert.equal(state.job.error_code, 'transcribe_key_unsupported');
});

test('a separate transcription key is used when set', async () => {
  let usedKey;
  const { deps, state } = harness({
    job: makeJob({ transcribe_api_key_id: 'key-2' }),
    keys: {
      'key-1': { provider: 'nebius', secret: 'nebius-secret-key-123' },
      'key-2': { provider: 'groq', secret: GROQ_KEY },
    },
    transcribe: async (_p, config) => { usedKey = config.apiKey; return 'words'; },
  });
  await processJob(JOB_ID, deps);
  assert.equal(usedKey, GROQ_KEY);
  assert.equal(state.generateCalls[0].llm.provider, 'nebius');
  assert.equal(state.job.status, 'succeeded');
});

test('unreadable media fails permanently instead of retrying', async () => {
  const { deps, state } = harness({ prepareAudio: async () => { throw new Error('ffmpeg exited 1: Invalid data'); } });
  await processJob(JOB_ID, deps);
  assert.equal(state.job.error_code, 'bad_media');
  assert.equal(state.workDirs.removed, 1);
});

test('silence produces a clear failure', async () => {
  const { deps, state } = harness({ transcribe: async () => { throw new Error('Transcription returned empty text. Is the audio file valid?'); } });
  await processJob(JOB_ID, deps);
  assert.equal(state.job.error_code, 'no_speech');
});

test('rate limits wait for the provider, without using up attempts', async () => {
  const err = Object.assign(new Error('Rate limit reached. Please try again in 1m30s.'), { status: 429 });
  const { deps, state } = harness({ transcribe: async () => { throw err; } });
  assert.deepEqual(await processJob(JOB_ID, deps), { outcome: 'deferred', delaySeconds: 90 });
  assert.equal(state.job.attempts, 0);
  assert.equal(state.job.locked_until, null);
});

test('a daily limit longer than the queue delay fails with the reset time', async () => {
  const err = Object.assign(new Error('Limit on audio seconds per day. Please try again in 2h5m0s.'), { status: 429 });
  const { deps, state } = harness({ transcribe: async () => { throw err; } });
  assert.deepEqual(await processJob(JOB_ID, deps), { outcome: 'failed' });
  assert.equal(state.job.error_code, 'rate_limited');
  assert.match(state.job.error_message, /about 125 min/);
});

test('transient errors retry with backoff, then give up', async () => {
  const err = Object.assign(new Error('upstream 503'), { status: 503 });
  const { deps, state } = harness({ transcribe: async () => { throw err; } });

  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
    assert.deepEqual(await processJob(JOB_ID, deps), { outcome: 'retrying', delaySeconds: 60 * attempt });
  }
  assert.deepEqual(await processJob(JOB_ID, deps), { outcome: 'failed' });
  assert.equal(state.job.attempts, MAX_ATTEMPTS);
  assert.equal(state.job.error_code, 'unavailable');
});

test('API keys never reach the stored error message or logs', async () => {
  const err = Object.assign(new Error(`Invalid API key: ${GROQ_KEY}`), { status: 401 });
  const { deps, state } = harness({ transcribe: async () => { throw err; } });
  await processJob(JOB_ID, deps);
  assert.equal(state.job.error_code, 'http_401');
  assert.doesNotMatch(state.job.error_message, /gsk_test/);
  assert.doesNotMatch(JSON.stringify(state.logs), /gsk_test/);
});

test('classify and scrub', () => {
  assert.equal(classify(new PermanentError('x')), 'permanent');
  assert.equal(classify(Object.assign(new Error('x'), { status: 404 })), 'permanent');
  assert.equal(classify(new Error('wrapped', { cause: Object.assign(new Error(), { status: 429 }) })), 'rate_limited');
  assert.equal(classify(new Error('ECONNRESET')), 'transient');
  assert.equal(scrub('key sk-proj_abcdefghijklmnop and gsk_ABCDEFGHIJKLMNOP'), 'key [redacted] and [redacted]');
});
