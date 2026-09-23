// POST /  {"jobId", "contentType", "size"}  ->  {"url", "fields", "expiresIn"}
// Served by a Lambda function URL; CORS is handled by the URL configuration.

import { createUpload, HttpError } from './lib/uploads.js';
import { getServiceKey, supabaseAdmin, supabaseRepo, s3Uploads, supabaseTokenVerifier } from './lib/services.js';

let deps;
async function getDeps() {
  if (!deps) {
    deps = {
      verifyToken: supabaseTokenVerifier(process.env.SUPABASE_URL),
      db: supabaseRepo(supabaseAdmin(process.env.SUPABASE_URL, await getServiceKey())),
      presign: s3Uploads(process.env.UPLOAD_BUCKET).presign,
    };
  }
  return deps;
}

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});

export async function handler(event) {
  if (event.requestContext?.http?.method !== 'POST') return json(405, { error: 'Use POST.' });

  let body;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body;
    body = JSON.parse(raw ?? '');
  } catch {
    return json(400, { error: 'Send a JSON body.' });
  }

  try {
    const result = await createUpload({ authorization: event.headers?.authorization, body }, await getDeps());
    return json(200, result);
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { error: err.message });
    console.log(JSON.stringify({ message: 'upload-url failed', error: err.message }));
    return json(500, { error: 'Couldn\'t start the upload. Try again.' });
  }
}
