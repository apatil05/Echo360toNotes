import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import {
  buildCandidateUrls,
  redactUrl,
  describeUrlSigning,
  describeCookies,
  summarise,
  runDiagnostics,
} from '../extension/lib/audioDiagnostics.js';

const NOW = Date.UTC(2026, 8, 16, 12, 0, 0);
const cfBase64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64')
  .replace(/\+/g, '-').replace(/=/g, '_').replace(/\//g, '~');
const policy = (extra = {}) => cfBase64({
  Statement: [{
    Resource: 'https://content.echo360.org/0000.2026/*',
    Condition: { DateLessThan: { 'AWS:EpochTime': NOW / 1000 + 3600 }, ...extra },
  }],
});

test('candidate URLs try low-quality variants first, then captured extras', () => {
  const urls = buildCandidateUrls([
    'https://content.echo360.org/x/s1q1.mp4?Policy=a',
    'https://content.echo360.org/x/master.m3u8',
  ]);
  assert.equal(urls.length, 7);
  assert.equal(urls[0], 'https://content.echo360.org/x/s0q0.mp4?Policy=a');
  assert.equal(urls[5], 'https://content.echo360.org/x/s2q1.mp4?Policy=a');
  assert.equal(urls[6], 'https://content.echo360.org/x/master.m3u8');
});

test('redaction keeps parameter names but never values', () => {
  const r = redactUrl('https://content.echo360.org/a/b/c/s0q0.mp4?Policy=SECRET&Signature=SECRET2&Key-Pair-Id=K');
  assert.equal(r, 'content.echo360.org/…/c/s0q0.mp4?Policy=…&Signature=…&Key-Pair-Id=…');
  assert.doesNotMatch(r, /SECRET/);
});

test('reads expiry and IP restriction from CloudFront and S3 signing', () => {
  const custom = describeUrlSigning(`https://h/s0q0.mp4?Policy=${policy({ IpAddress: { 'AWS:SourceIp': '1.2.3.4/32' } })}&Signature=x`, NOW);
  assert.deepEqual(custom, { signed: true, style: 'cloudfront-policy', expiresInMin: 60, ipRestricted: true, wildcardResource: true });

  const canned = describeUrlSigning(`https://h/a.mp4?Expires=${NOW / 1000 + 600}&Signature=x&Key-Pair-Id=k`, NOW);
  assert.equal(canned.expiresInMin, 10);

  const s3 = describeUrlSigning('https://h/a.mp4?X-Amz-Date=20260916T115000Z&X-Amz-Expires=1800&X-Amz-Signature=x', NOW);
  assert.equal(s3.expiresInMin, 20);

  assert.deepEqual(describeUrlSigning('https://h/a.mp4', NOW), { signed: false, paramNames: [] });
});

test('cookie summary lists names only', () => {
  const info = describeCookies([
    { name: 'CloudFront-Policy', value: policy(), domain: '.echo360.org' },
    { name: 'PLAY_SESSION', value: 'SECRET', domain: 'echo360.org' },
  ], NOW);
  assert.deepEqual(info.byDomain, { '.echo360.org': ['CloudFront-Policy'], 'echo360.org': ['PLAY_SESSION'] });
  assert.equal(info.cloudFrontPolicy.expiresInMin, 60);
  assert.doesNotMatch(JSON.stringify(info), /SECRET/);
});

// ── End to end against a fake Echo360 CDN ───────────────────────────────────

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
let dir;
const files = {};

before(() => {
  if (!hasFfmpeg) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-'));
  const run = (args) => assert.equal(spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]).status, 0);
  files['s0q0.mp4'] = path.join(dir, 'screen.mp4');
  run(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', files['s0q0.mp4']]);
  files['s1q0.mp4'] = path.join(dir, 'camera.mp4');
  run(['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=4', '-f', 'lavfi', '-i', 'sine=duration=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-shortest', files['s1q0.mp4']]);
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

// Serves s0q0 (video only) and s1q0 (video + audio); everything else 403s.
// Requests without cookies are rejected, like CloudFront signed cookies.
function fakeCdn({ requireSession = true, honourRange = true } = {}) {
  return async (url, init) => {
    const name = new URL(url).pathname.split('/').pop();
    if (requireSession && init.credentials !== 'include') return new Response('denied', { status: 403 });
    const file = files[name];
    if (!file) return new Response('missing', { status: 403 });
    const buf = fs.readFileSync(file);
    const m = init.headers?.Range?.match(/bytes=(\d+)-(\d+)/);
    if (!m || !honourRange) {
      return new Response(buf, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(buf.length) } });
    }
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), buf.length - 1);
    return new Response(buf.subarray(start, end + 1), {
      status: 206,
      headers: { 'content-type': 'video/mp4', 'content-range': `bytes ${start}-${end}/${buf.length}` },
    });
  };
}

const skip = hasFfmpeg ? false : 'ffmpeg not installed';
const state = {
  videoUrls: [`https://content.echo360.org/0000.2026/lesson/s0q0.mp4?Policy=${policy()}&Signature=SIGSECRET&Key-Pair-Id=k`],
  transcriptUrl: null,
};

test('finds the audio stream, confirms the session is required, and redacts', { skip }, async () => {
  const impl = fakeCdn();
  const report = await runDiagnostics({
    state,
    cookies: [{ name: 'CloudFront-Policy', value: policy({ IpAddress: { 'AWS:SourceIp': '9.9.9.9/32' } }), domain: '.echo360.org' }],
    fetchImpl: impl,
    now: NOW,
  });

  const { summary } = report;
  assert.equal(summary.streamsTried, 6);
  assert.equal(summary.streamsReachable, 2);
  assert.equal(summary.rangeRequestsWork, true);
  assert.equal(summary.serverWithoutSessionBlocked, true);
  assert.equal(summary.ipRestricted, true);
  assert.equal(summary.accessExpiresInMin, 60);
  assert.match(summary.audio.stream, /s1q0\.mp4/);
  assert.equal(summary.audio.audioOnlyStream, false);
  assert.equal(summary.audio.codec, 'mp4a');
  assert.equal(summary.audio.fitsWhisperAsIs, true);
  assert.ok(summary.verdict.some(v => v.startsWith('OK: audio is inside a video stream')));
  assert.ok(summary.verdict.some(v => v.startsWith('CONFIRMED: access is locked to your IP')));

  assert.equal(report.streams.find(s => s.url.includes('s0q0')).captured, true);
  assert.deepEqual(report.streams.find(s => s.url.includes('s0q0')).mp4.tracks.map(t => t.kind), ['video']);
  assert.doesNotMatch(JSON.stringify(report), /SIGSECRET|9\.9\.9\.9|Policy=[^…]/);
});

test('reports when streams are public and the server ignores Range', { skip }, async () => {
  const impl = fakeCdn({ requireSession: false, honourRange: false });
  const report = await runDiagnostics({ state, fetchImpl: impl, now: NOW });
  assert.equal(report.summary.serverWithoutSessionBlocked, false);
  assert.equal(report.summary.rangeRequestsWork, false);
  assert.equal(report.summary.audio, null);
  assert.ok(report.summary.verdict.some(v => v.startsWith('FAIL: no reachable MP4 stream had an audio track')));
});

test('fragmented audio-only stream: size from file, duration from the HLS playlist', () => {
  const ok = { status: 206, rangeSupported: true };
  const signing = { signed: 'unknown', paramNames: ['x-uid'] };
  const results = [
    { url: 'a/s0q0.mp4', signing, withSession: ok, withoutSession: { status: 206 }, fileMB: 25.84,
      mp4: { moovBeforeMdat: true, fragmented: true, tracks: [{ kind: 'audio', codec: 'mp4a', durationMin: null, payloadMB: null, channels: 1, kbps: null }] } },
    { url: 'a/s1q0.mp4', signing, withSession: ok, withoutSession: { status: 206 }, fileMB: 11.38,
      mp4: { moovBeforeMdat: true, fragmented: true, tracks: [{ kind: 'video', codec: 'avc1', durationMin: null, payloadMB: null }] } },
    { url: 'a/s0q0.m3u8', signing, withSession: { status: 200 }, withoutSession: { status: 200 },
      manifest: { variants: 0, audioRenditions: 0, segments: 451, durationMin: 75.1, segmentExt: 'mp4' } },
  ];
  const cookies = describeCookies([{ name: 'CloudFront-Policy', value: policy(), domain: '.echo360.org' }], NOW);
  const s = summarise(results, cookies);
  assert.equal(s.audio.durationMin, 75.1);
  assert.equal(s.audio.durationSource, 'hls-playlist');
  assert.equal(s.audio.audioTrackMB, 25.84);
  assert.equal(s.audio.kbps, 46);
  assert.equal(s.audio.fitsWhisperAsIs, false);
  assert.equal(s.audio.reencodedOpusMB, 9.6);
  assert.equal(s.audio.fitsWhisperAfterReencode, true);
  assert.equal(s.accessExpiresInMin, null); // cookie expiry is irrelevant when cookies aren't needed
  assert.ok(s.verdict.some(v => v.startsWith("NOTE: the raw audio (25.84 MB) is over Whisper's 25 MB limit")));
  assert.ok(s.verdict.some(v => v.startsWith('NOTE: stream URLs carry no signature')));
});

test('fails clearly when nothing was captured', async () => {
  const report = await runDiagnostics({ state: {}, fetchImpl: async () => { throw new Error('unused'); }, now: NOW });
  assert.equal(report.summary.streamsTried, 0);
  assert.match(report.summary.verdict[0], /^FAIL: the extension could not fetch any stream/);
});
