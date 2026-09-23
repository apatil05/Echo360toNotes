// Issues a short-lived S3 upload form for a job's audio or recording.
//
// The student proves who they are with their Supabase access token; the job
// must be theirs, run on Lambda, and not have started. The form is locked to
// one object key, the declared size, and content type.

export const UPLOAD_EXPIRES_SECONDS = 15 * 60;
export const MAX_UPLOAD_BYTES = 1024 ** 3; // 1 GiB

export const ALLOWED_TYPES = new Set([
  'audio/mp4', 'audio/x-m4a', 'audio/mpeg', 'audio/aac', 'audio/wav', 'audio/x-wav',
  'audio/webm', 'audio/ogg', 'audio/flac',
  'video/mp4', 'video/webm', 'video/quicktime',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function uploadKey(userId, jobId) {
  return `uploads/${userId}/${jobId}`;
}

/** Parses `uploads/<userId>/<jobId>` back into its parts, or null. */
export function parseUploadKey(key) {
  const m = /^uploads\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/i.exec(decodeURIComponent(key.replace(/\+/g, ' ')));
  return m && UUID.test(m[1]) && UUID.test(m[2]) ? { userId: m[1], jobId: m[2] } : null;
}

/**
 * @param {{authorization?: string, body: any}} request
 * @param {{verifyToken: Function, db: object, presign: Function}} deps
 */
export async function createUpload({ authorization, body }, { verifyToken, db, presign }) {
  const token = /^Bearer\s+(.+)$/i.exec(authorization ?? '')?.[1];
  if (!token) throw new HttpError(401, 'Sign in first.');
  let userId;
  try {
    userId = await verifyToken(token);
  } catch {
    throw new HttpError(401, 'Your session has expired. Sign in again.');
  }

  const { jobId, contentType, size } = body ?? {};
  if (typeof jobId !== 'string' || !UUID.test(jobId)) throw new HttpError(400, 'jobId must be a job id.');
  if (!ALLOWED_TYPES.has(contentType)) throw new HttpError(400, 'That file type isn\'t supported. Upload audio or video.');
  if (!Number.isInteger(size) || size < 1) throw new HttpError(400, 'size must be the file size in bytes.');
  if (size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'Files can be up to 1 GB. Upload just the audio if you can.');

  const job = await db.getJob(jobId);
  // Someone else's job looks the same as a missing one.
  if (!job || job.user_id !== userId) throw new HttpError(404, 'Job not found.');
  if (job.runner !== 'lambda' || !['audio', 'media_file'].includes(job.source)) {
    throw new HttpError(400, 'This job doesn\'t take an upload.');
  }

  const key = uploadKey(userId, jobId);
  const claimed = await db.markUploading(jobId, { audio_object_key: key, audio_bytes: size });
  if (!claimed) throw new HttpError(409, 'This job already has an upload.');

  const form = await presign({ key, contentType, size, expiresSeconds: UPLOAD_EXPIRES_SECONDS });
  return { url: form.url, fields: form.fields, expiresIn: UPLOAD_EXPIRES_SECONDS };
}
