import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet, jwtVerify } from 'jose';

import { createUpload, parseUploadKey, uploadKey, MAX_UPLOAD_BYTES } from '../lambda/lib/uploads.js';
import { jobIdsFromMessage } from '../lambda/worker.js';

const ISSUER = 'https://demo.supabase.co/auth/v1';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const JOB = '33333333-3333-4333-8333-333333333333';

let keys;
let verifyToken;

// Same checks as supabaseTokenVerifier, against a local key set.
before(async () => {
  keys = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'test', alg: 'ES256' };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  verifyToken = async (token) => {
    const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER, audience: 'authenticated' });
    if (payload.role !== 'authenticated') throw new Error('not a user');
    return payload.sub;
  };
});

const tokenFor = (sub, { role = 'authenticated', exp = '1h', issuer = ISSUER } = {}) =>
  new SignJWT({ role }).setProtectedHeader({ alg: 'ES256', kid: 'test' })
    .setSubject(sub).setIssuer(issuer).setAudience('authenticated').setIssuedAt().setExpirationTime(exp)
    .sign(keys.privateKey);

function fakeDb(job) {
  const state = { job: job && { ...job }, marked: [] };
  return {
    state,
    getJob: async (id) => (state.job?.id === id ? state.job : null),
    markUploading: async (id, fields) => {
      if (state.job.status !== 'queued') return false;
      state.marked.push(fields);
      Object.assign(state.job, fields, { status: 'uploading' });
      return true;
    },
  };
}

const presign = async (args) => ({ url: 'https://bucket.s3.amazonaws.com/', fields: { key: args.key, Policy: 'p' }, args });
const aliceJob = { id: JOB, user_id: ALICE, runner: 'lambda', source: 'audio', status: 'queued' };
const body = { jobId: JOB, contentType: 'audio/mp4', size: 25_840_000 };

async function call({ token, reqBody = body, job = aliceJob } = {}) {
  const db = fakeDb(job);
  const authorization = token === undefined ? `Bearer ${await tokenFor(ALICE)}` : token;
  try {
    return { result: await createUpload({ authorization, body: reqBody }, { verifyToken, db, presign }), db };
  } catch (err) {
    return { status: err.status, message: err.message, db };
  }
}

test('issues a form locked to the job key and marks the job uploading', async () => {
  const { result, db } = await call();
  assert.equal(result.fields.key, `uploads/${ALICE}/${JOB}`);
  assert.equal(result.expiresIn, 900);
  assert.deepEqual(db.state.marked, [{ audio_object_key: `uploads/${ALICE}/${JOB}`, audio_bytes: 25_840_000 }]);
  assert.equal(db.state.job.status, 'uploading');
});

test('rejects missing, forged, expired, and non-user tokens', async () => {
  const other = await generateKeyPair('ES256');
  const forged = await new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'ES256', kid: 'test' })
    .setSubject(ALICE).setIssuer(ISSUER).setAudience('authenticated').setExpirationTime('1h').sign(other.privateKey);

  for (const token of [
    '',
    'Bearer not-a-jwt',
    `Bearer ${forged}`,
    `Bearer ${await tokenFor(ALICE, { exp: Math.floor(Date.now() / 1000) - 60 })}`,
    `Bearer ${await tokenFor(ALICE, { role: 'anon' })}`,
    `Bearer ${await tokenFor(ALICE, { issuer: 'https://evil.example/auth/v1' })}`,
  ]) {
    const { status, db } = await call({ token });
    assert.equal(status, 401, token.slice(0, 20));
    assert.equal(db.state.marked.length, 0);
  }
});

test("someone else's job looks like a missing job", async () => {
  const { status, db } = await call({ token: `Bearer ${await tokenFor(BOB)}` });
  assert.equal(status, 404);
  assert.equal(db.state.marked.length, 0);
});

test('validates the request body', async () => {
  const cases = [
    [{ ...body, jobId: '../../etc' }, 400],
    [{ ...body, contentType: 'text/html' }, 400],
    [{ ...body, contentType: 'application/x-msdownload' }, 400],
    [{ ...body, size: 0 }, 400],
    [{ ...body, size: 1.5 }, 400],
    [{ ...body, size: MAX_UPLOAD_BYTES + 1 }, 413],
  ];
  for (const [reqBody, expected] of cases) {
    assert.equal((await call({ reqBody })).status, expected, JSON.stringify(reqBody));
  }
});

test('only Lambda audio/recording jobs take uploads, and only once', async () => {
  assert.equal((await call({ job: { ...aliceJob, runner: 'browser', source: 'captions' } })).status, 400);
  assert.equal((await call({ job: { ...aliceJob, status: 'uploading' } })).status, 409);
  assert.equal((await call({ job: { ...aliceJob, source: 'media_file' } })).result.fields.key, `uploads/${ALICE}/${JOB}`);
});

test('upload keys round-trip and reject anything else', () => {
  assert.deepEqual(parseUploadKey(uploadKey(ALICE, JOB)), { userId: ALICE, jobId: JOB });
  assert.equal(parseUploadKey(`uploads/${ALICE}/${JOB}/extra`), null);
  assert.equal(parseUploadKey(`other/${ALICE}/${JOB}`), null);
  assert.equal(parseUploadKey('uploads/x/y'), null);
});

test('worker reads job ids from S3 events and continuations', () => {
  const s3Event = JSON.stringify({
    Records: [
      { eventSource: 'aws:s3', eventName: 'ObjectCreated:Post', s3: { object: { key: `uploads/${ALICE}/${JOB}` } } },
      { eventSource: 'aws:s3', eventName: 'ObjectRemoved:Delete', s3: { object: { key: `uploads/${ALICE}/${JOB}` } } },
      { eventSource: 'aws:s3', eventName: 'ObjectCreated:Put', s3: { object: { key: 'uploads/junk' } } },
    ],
  });
  assert.deepEqual(jobIdsFromMessage(s3Event), [JOB]);
  assert.deepEqual(jobIdsFromMessage(JSON.stringify({ jobId: JOB })), [JOB]);
  assert.deepEqual(jobIdsFromMessage(JSON.stringify({ Event: 's3:TestEvent' })), []);
  assert.deepEqual(jobIdsFromMessage('not json'), []);
});
