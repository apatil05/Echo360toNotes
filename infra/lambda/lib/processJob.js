// Runs one lecture job: audio in S3 -> transcript -> notes in Supabase.
//
// Lambda stops after 15 minutes and Groq's free tier needs ~1 minute between
// notes chunks, so a job may take several invocations. Each one leases the job,
// saves progress after every step, and re-queues itself when time runs short.
// All I/O goes through `deps` so this file is testable without AWS.

import path from 'node:path';
import {
  resolveLLMConfig,
  resolveTranscribeConfig,
  assertReady,
  ConfigError,
  TRANSCRIBE_PROVIDERS,
} from '../../../src/providers.js';

export const LEASE_SECONDS = 16 * 60; // longer than the 15-minute Lambda timeout
export const MAX_ATTEMPTS = 3;
export const MAX_QUEUE_DELAY_SECONDS = 900; // SQS limit
// Time to leave for one notes chunk plus saving it (slow models can stream for minutes).
export const CHUNK_BUDGET_MS = 4 * 60_000;
// Time to leave for download, ffmpeg, and Whisper on a long lecture.
export const TRANSCRIBE_BUDGET_MS = 8 * 60_000;

/** An error retrying won't fix (bad key, missing model, broken file). */
export class PermanentError extends Error {
  constructor(message, code = 'invalid_input') {
    super(message);
    this.name = 'PermanentError';
    this.code = code;
  }
}

/** Ran out of time before a step could start: continue in a new invocation. */
class OutOfTime extends Error {}

/**
 * @returns {Promise<{outcome: 'skipped'|'succeeded'|'deferred'|'retrying'|'failed', delaySeconds?: number}>}
 */
export async function processJob(jobId, deps) {
  const { db } = deps;
  const job = await db.claimJob(jobId, LEASE_SECONDS);
  if (!job) {
    deps.log('job not claimable (finished, missing, or leased by another run)', { jobId });
    return { outcome: 'skipped' };
  }

  const secrets = [];
  try {
    return await runJob(job, deps, secrets);
  } catch (err) {
    return await handleFailure(job, err, deps, secrets);
  }
}

async function runJob(job, deps, secrets) {
  const { db } = deps;

  const lecture = await db.getLecture(job.lecture_id);
  if (!lecture) throw new PermanentError('The lecture for this job no longer exists.', 'lecture_missing');

  const notesKey = await loadKey(db, job.api_key_id, 'notes', secrets);
  const llm = buildConfig(() => resolveLLMConfig({
    env: {},
    overrides: {
      provider: job.notes_provider ?? notesKey.provider,
      model: job.notes_model,
      apiKey: notesKey.secret,
      baseURL: notesKey.baseUrl,
    },
  }));

  const transcript = job.transcript_path
    ? await db.loadTranscript(job.transcript_path)
    : await transcribeJob(job, deps, secrets);

  let slides = null;
  if (job.slides_path) {
    slides = await deps.readSlides(job.slides_path).catch((err) => {
      deps.log('slides unreadable, continuing without them', { jobId: job.id, error: err.message });
      return null;
    });
  }

  // Saved parts are only valid for the chunk size they were written with.
  const saved = job.checkpoint?.chunkChars === llm.chunkChars ? job.checkpoint.parts ?? [] : [];

  await db.updateJob(job.id, { status: 'generating', status_detail: 'Writing notes…', progress: Math.max(job.progress, 40) });

  const result = await deps.generateNotes(transcript, llm, {
    course: lecture.course_code ?? 'Lecture',
    topic: lecture.topic ?? undefined,
    slides,
    date: lecture.lecture_date,
  }, {
    parts: saved,
    onPart: (parts, total) => db.updateJob(job.id, {
      checkpoint: { chunkChars: llm.chunkChars, parts },
      chunks_total: total,
      chunks_done: parts.length,
      progress: 40 + Math.floor((55 * parts.length) / total),
    }),
    canContinue: (waitMs) => deps.remainingMs() - waitMs > CHUNK_BUDGET_MS,
  });

  if (!result.done) {
    const delaySeconds = Math.min(MAX_QUEUE_DELAY_SECONDS, Math.ceil(result.resumeAfterMs / 1000));
    await db.updateJob(job.id, {
      locked_until: null,
      status_detail: `Written ${result.parts.length} of ${result.total} sections, continuing shortly…`,
    });
    await deps.requeue(job.id, delaySeconds);
    return { outcome: 'deferred', delaySeconds };
  }

  await db.upsertNote({
    user_id: job.user_id,
    lecture_id: job.lecture_id,
    job_id: job.id,
    title: titleOf(result.notes, lecture),
    body_md: result.notes,
    word_count: countWords(result.notes),
    transcript_path: job.transcript_path ?? null,
  });
  await db.updateJob(job.id, {
    status: 'succeeded',
    status_detail: null,
    progress: 100,
    checkpoint: null,
    locked_until: null,
    finished_at: new Date().toISOString(),
    error_code: null,
    error_message: null,
  });
  await deleteUpload(job, deps);
  return { outcome: 'succeeded' };
}

async function transcribeJob(job, deps, secrets) {
  const { db } = deps;
  if (!job.audio_object_key) throw new PermanentError('No audio was uploaded for this job.', 'audio_missing');
  if (deps.remainingMs() < TRANSCRIBE_BUDGET_MS) throw new OutOfTime();

  const key = await loadKey(db, job.transcribe_api_key_id ?? job.api_key_id, 'transcription', secrets);
  if (!TRANSCRIBE_PROVIDERS[key.provider]) {
    throw new PermanentError(
      `Lectures without captions need a key that can transcribe audio (Groq or OpenAI); your ${key.provider} key can only write notes. Add a transcription key in Settings.`,
      'transcribe_key_unsupported',
    );
  }
  const config = buildConfig(() => resolveTranscribeConfig({
    env: {},
    overrides: { provider: key.provider, model: job.transcribe_model, apiKey: key.secret, baseURL: key.baseUrl },
  }));

  await db.updateJob(job.id, { status: 'transcribing', status_detail: 'Preparing audio…', progress: Math.max(job.progress, 5) });

  const workDir = await deps.makeWorkDir(job.id);
  try {
    const source = path.join(workDir, 'source');
    await deps.downloadUpload(job.audio_object_key, source);
    let segments;
    try {
      segments = await deps.prepareAudio(source, workDir, config.maxBytes);
    } catch (err) {
      deps.log('ffmpeg failed', { jobId: job.id, error: err.message });
      throw new PermanentError('Couldn\'t read any audio from the uploaded file. Is it a working recording?', 'bad_media');
    }

    const texts = [];
    for (const [i, segment] of segments.entries()) {
      await db.updateJob(job.id, {
        status_detail: segments.length > 1 ? `Transcribing part ${i + 1} of ${segments.length}…` : 'Transcribing…',
        progress: 10 + Math.floor((25 * i) / segments.length),
      });
      try {
        texts.push(await deps.transcribe(segment, config));
      } catch (err) {
        if (/returned empty text/.test(err.message)) continue; // a silent piece
        throw err;
      }
    }
    const transcript = texts.join(' ').trim();
    if (!transcript) throw new PermanentError('No speech was found in the audio.', 'no_speech');

    const transcriptPath = `${job.user_id}/${job.id}.txt`;
    await db.saveTranscript(transcriptPath, transcript);
    await db.updateJob(job.id, { transcript_path: transcriptPath, progress: 40 });
    job.transcript_path = transcriptPath;
    return transcript;
  } finally {
    await deps.removeWorkDir(workDir);
  }
}

async function loadKey(db, keyId, purpose, secrets) {
  if (!keyId) throw new PermanentError(`No API key is set for ${purpose}. Add one in Settings.`, 'key_missing');
  const key = await db.getApiKey(keyId);
  if (!key) throw new PermanentError(`The API key for ${purpose} was deleted. Add one in Settings.`, 'key_missing');
  secrets.push(key.secret);
  return key;
}

function buildConfig(resolve) {
  try {
    const config = resolve();
    assertReady(config);
    return config;
  } catch (err) {
    if (err instanceof ConfigError) throw new PermanentError(err.message, 'config');
    throw err;
  }
}

async function handleFailure(job, err, deps, secrets) {
  const { db } = deps;

  if (err instanceof OutOfTime) {
    await db.updateJob(job.id, { locked_until: null });
    await deps.requeue(job.id, 0);
    return { outcome: 'deferred', delaySeconds: 0 };
  }

  const kind = classify(err);
  const message = scrub(err.message ?? String(err), secrets);
  deps.log('job step failed', { jobId: job.id, kind, status: err.status, error: message });

  if (kind === 'rate_limited') {
    const waitSeconds = Math.ceil((retryAfterMs(err) ?? 60_000) / 1000);
    if (waitSeconds <= MAX_QUEUE_DELAY_SECONDS) {
      await db.updateJob(job.id, { locked_until: null, status_detail: 'Provider rate limit reached, waiting to retry…' });
      await deps.requeue(job.id, waitSeconds);
      return { outcome: 'deferred', delaySeconds: waitSeconds };
    }
    return fail(job, deps, 'rate_limited',
      `Your provider's usage limit is used up for now (resets in about ${Math.ceil(waitSeconds / 60)} min). Try again later.`);
  }

  if (kind === 'transient') {
    const attempts = job.attempts + 1;
    if (attempts < MAX_ATTEMPTS) {
      const delaySeconds = 60 * attempts;
      await db.updateJob(job.id, { attempts, locked_until: null, status_detail: 'Something went wrong, retrying…' });
      await deps.requeue(job.id, delaySeconds);
      return { outcome: 'retrying', delaySeconds };
    }
    return fail(job, deps, 'unavailable', `Gave up after ${attempts} attempts: ${message}`, attempts);
  }

  return fail(job, deps, err.code && typeof err.code === 'string' ? err.code : `http_${err.status ?? 'error'}`, message);
}

async function fail(job, deps, code, message, attempts = job.attempts) {
  await deps.db.updateJob(job.id, {
    status: 'failed',
    status_detail: null,
    error_code: code,
    error_message: message.slice(0, 2000),
    attempts,
    locked_until: null,
    finished_at: new Date().toISOString(),
  });
  await deleteUpload(job, deps);
  return { outcome: 'failed' };
}

async function deleteUpload(job, deps) {
  if (!job.audio_object_key) return;
  // Best effort: the bucket's lifecycle rule removes leftovers after a day.
  await deps.deleteUpload(job.audio_object_key).catch((err) => {
    deps.log('could not delete upload', { jobId: job.id, error: err.message });
  });
}

export function classify(err) {
  if (err instanceof PermanentError) return 'permanent';
  const status = err?.status;
  if (status === 429) return 'rate_limited';
  if (status === 408 || status === 409 || (status >= 500 && status < 600)) return 'transient';
  if (status >= 400 && status < 500) return 'permanent';
  // Wrapped provider errors keep the original on `cause`.
  if (err?.cause && err.cause !== err) return classify(err.cause);
  return 'transient';
}

function retryAfterMs(err) {
  for (const e of [err, err?.cause]) {
    const header = (name) => e?.headers?.get?.(name) ?? e?.headers?.[name];
    const secs = Number(header('retry-after'));
    if (Number.isFinite(secs) && secs > 0) return secs * 1000;
    const m = (e?.message ?? '').match(/try again in (?:(\d+)h)?(?:(\d+)m)?([\d.]+)s/i);
    if (m) return ((Number(m[1] ?? 0) * 3600) + (Number(m[2] ?? 0) * 60) + parseFloat(m[3])) * 1000;
  }
  return null;
}

/** Removes API keys from text that may be logged or shown to the student. */
export function scrub(text, secrets = []) {
  let out = String(text);
  for (const s of secrets) if (s && s.length >= 8) out = out.split(s).join('[redacted]');
  return out.replace(/\b(gsk_|sk-|sk_|or-|v1\.)[A-Za-z0-9_\-]{12,}/g, '[redacted]');
}

function titleOf(notes, lecture) {
  const heading = notes.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return (heading || lecture.topic || 'Lecture notes').slice(0, 300);
}

function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}
