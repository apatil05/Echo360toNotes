// SQS consumer. Messages are either S3 "object created" events for new uploads
// or {"jobId"} continuations the worker queued for itself.

import { processJob } from './lib/processJob.js';
import { parseUploadKey } from './lib/uploads.js';
import {
  getServiceKey,
  supabaseAdmin,
  supabaseRepo,
  s3Uploads,
  sqsRequeue,
  prepareAudio,
  makeWorkDir,
  removeWorkDir,
} from './lib/services.js';
import { generateNotesResumable } from '../../src/notesGenerator.js';
import { transcribeAudio } from '../../src/transcriber.js';
import { parsePdfBuffer } from '../../src/slideParser.js';

const log = (message, fields = {}) => console.log(JSON.stringify({ message, ...fields }));

/** Job ids referenced by one SQS message body. */
export function jobIdsFromMessage(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (typeof parsed?.jobId === 'string') return [parsed.jobId];
  if (parsed?.Event === 's3:TestEvent') return [];
  return (parsed?.Records ?? [])
    .filter((r) => r.eventSource === 'aws:s3' && r.eventName?.startsWith('ObjectCreated:'))
    .map((r) => parseUploadKey(r.s3.object.key)?.jobId)
    .filter(Boolean);
}

let deps;
async function getDeps(context) {
  if (!deps) {
    const repo = supabaseRepo(supabaseAdmin(process.env.SUPABASE_URL, await getServiceKey()));
    const s3 = s3Uploads(process.env.UPLOAD_BUCKET);
    deps = {
      db: repo,
      downloadUpload: s3.download,
      deleteUpload: s3.remove,
      requeue: sqsRequeue(process.env.QUEUE_URL),
      prepareAudio,
      makeWorkDir,
      removeWorkDir,
      transcribe: transcribeAudio,
      generateNotes: generateNotesResumable,
      readSlides: async (p) => parsePdfBuffer(await repo.readSlidesBuffer(p)),
      log,
    };
  }
  return { ...deps, remainingMs: () => context.getRemainingTimeInMillis() };
}

export async function handler(event, context) {
  const failures = [];
  for (const record of event.Records) {
    try {
      const d = await getDeps(context);
      for (const jobId of jobIdsFromMessage(record.body)) {
        const result = await processJob(jobId, d);
        log('job processed', { jobId, ...result });
      }
    } catch (err) {
      // Unexpected (e.g. Supabase unreachable): let SQS redeliver; the lease
      // expires before the message becomes visible again.
      log('message failed', { messageId: record.messageId, error: err.message });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}
