// Real implementations of the dependencies used by processJob and createUpload.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createClient } from '@supabase/supabase-js';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

import { extractAudio } from '../../../src/media.js';

let serviceKey;

/** Reads the Supabase secret key from SSM once per container. */
export async function getServiceKey(env = process.env) {
  if (serviceKey) return serviceKey;
  if (env.SUPABASE_SERVICE_KEY) return (serviceKey = env.SUPABASE_SERVICE_KEY); // local runs only
  const ssm = new SSMClient({});
  const out = await ssm.send(new GetParameterCommand({ Name: env.SUPABASE_SERVICE_KEY_PARAM, WithDecryption: true }));
  serviceKey = out.Parameter.Value;
  return serviceKey;
}

export function supabaseAdmin(url, key) {
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

const must = ({ data, error, status }) => {
  if (error) {
    const err = new Error(`Supabase: ${error.message}`);
    // PostgREST puts the HTTP status on the response, storage on the error.
    // A 4xx means our request is wrong (don't retry); unknown means retry.
    err.status = Number(status ?? error.status ?? error.statusCode) || undefined;
    throw err;
  }
  return data;
};

/** Database and Supabase Storage access for the worker and upload API. */
export function supabaseRepo(sb) {
  return {
    async claimJob(jobId, leaseSeconds) {
      const rows = must(await sb.rpc('claim_job', { p_job_id: jobId, p_lease_seconds: leaseSeconds }));
      return rows?.[0] ?? null;
    },
    async getJob(jobId) {
      return must(await sb.from('jobs').select('*').eq('id', jobId).maybeSingle());
    },
    async markUploading(jobId, fields) {
      const rows = must(await sb.from('jobs')
        .update({ ...fields, status: 'uploading', status_detail: 'Uploading audio…' })
        .eq('id', jobId).eq('status', 'queued').select('id'));
      return rows.length === 1;
    },
    async updateJob(jobId, fields) {
      must(await sb.from('jobs').update(fields).eq('id', jobId));
    },
    async getLecture(lectureId) {
      const row = must(await sb.from('lectures')
        .select('id, topic, lecture_date, courses(code)').eq('id', lectureId).maybeSingle());
      return row && { ...row, course_code: row.courses?.code ?? null };
    },
    async getApiKey(keyId) {
      const row = must(await sb.from('api_keys').select('id, provider, base_url').eq('id', keyId).maybeSingle());
      if (!row) return null;
      const secret = must(await sb.rpc('get_api_key_secret', { p_key_id: keyId }));
      return { provider: row.provider, baseUrl: row.base_url ?? undefined, secret };
    },
    async saveTranscript(objectPath, text) {
      must(await sb.storage.from('transcripts').upload(objectPath, new Blob([text], { type: 'text/plain' }), { upsert: true, contentType: 'text/plain' }));
    },
    async loadTranscript(objectPath) {
      const blob = must(await sb.storage.from('transcripts').download(objectPath));
      return blob.text();
    },
    async readSlidesBuffer(objectPath) {
      const blob = must(await sb.storage.from('slides').download(objectPath));
      return Buffer.from(await blob.arrayBuffer());
    },
    async upsertNote(note) {
      must(await sb.from('notes').upsert(note, { onConflict: 'job_id' }));
    },
  };
}

export function s3Uploads(bucket, client = new S3Client({})) {
  return {
    async download(key, destPath) {
      const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      await pipeline(out.Body instanceof Readable ? out.Body : Readable.fromWeb(out.Body), fs.createWriteStream(destPath));
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
    presign({ key, contentType, size, expiresSeconds }) {
      return createPresignedPost(client, {
        Bucket: bucket,
        Key: key,
        Conditions: [
          ['content-length-range', size, size],
          ['eq', '$Content-Type', contentType],
        ],
        Fields: { 'Content-Type': contentType },
        Expires: expiresSeconds,
      });
    },
  };
}

export function sqsRequeue(queueUrl, client = new SQSClient({})) {
  return (jobId, delaySeconds) => client.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify({ jobId }),
    DelaySeconds: delaySeconds,
  }));
}

/** Verifies a Supabase access token and returns the user id. */
export function supabaseTokenVerifier(supabaseUrl) {
  const issuer = `${supabaseUrl.replace(/\/$/, '')}/auth/v1`;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  return async (token) => {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: 'authenticated' });
    if (payload.role !== 'authenticated' || typeof payload.sub !== 'string') throw new Error('not a user token');
    return payload.sub;
  };
}

/**
 * Converts any audio/video to mono 16 kbps Opus and splits it into pieces that
 * fit the transcription upload limit. Returns the piece paths in order.
 */
export async function prepareAudio(source, workDir, maxBytes) {
  const opus = path.join(workDir, 'audio.opus');
  await extractAudio(source, opus);
  fs.rmSync(source, { force: true });

  const size = fs.statSync(opus).size;
  if (size <= maxBytes * 0.95) return [opus];

  // 16 kbps is ~7 MB/hour; two-hour pieces stay well under 25 MB.
  const pattern = path.join(workDir, 'part-%03d.opus');
  await runFfmpeg(['-y', '-i', opus, '-f', 'segment', '-segment_time', '7200', '-c', 'copy', pattern]);
  fs.rmSync(opus, { force: true });
  return fs.readdirSync(workDir).filter((f) => /^part-\d{3}\.opus$/.test(f)).sort().map((f) => path.join(workDir, f));
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.env.FFMPEG_PATH?.trim() || 'ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (c) => { stderr += c; });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`))));
  });
}

export function makeWorkDir(jobId) {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), `job-${jobId}-`));
}

export function removeWorkDir(dir) {
  return fs.promises.rm(dir, { recursive: true, force: true });
}
