#!/usr/bin/env node
// End-to-end test against the REAL provider APIs configured in .env (uses a little quota).
//
// Covers: server boot + /health, the origin guard, /generate (VTT + slides, SRT, no
// overwrite on same-day lectures, empty captions), /generate-from-video (stream discovery
// → download → ffprobe → ffmpeg → transcription → notes), and the CLI (multi-chunk notes,
// video file input, config errors). Output goes to a temp dir — never your real vault.
//
//   npm run test:e2e
//   LLM_PROVIDER=nebius npm run test:e2e      # try another provider
//   E2E_SKIP_AUDIO=1 npm run test:e2e         # skip the transcription steps

import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

import { resolveLLMConfig, resolveTranscribeConfig, describe } from '../src/providers.js';
import { LECTURE_TEXT, SLIDE_LINES, toVtt, toSrt, makePdf } from '../test/fixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-notes-e2e-'));
const VAULT = path.join(TMP, 'vault');
const FIXTURES = path.join(TMP, 'fixtures');
const MEDIA_ROOT = path.join(FIXTURES, 'media');
const LESSON_MEDIA = path.join(MEDIA_ROOT, 'lesson1');
fs.mkdirSync(LESSON_MEDIA, { recursive: true });

const results = [];
let serverLog = '';

console.log(`\nE2E workspace: ${TMP}`);
console.log(`Notes model:   ${safe(() => describe(resolveLLMConfig()))}`);
console.log(`Transcription: ${safe(() => describe(resolveTranscribeConfig()))}\n`);

// ─── Fixtures ────────────────────────────────────────────────────────────────
const vttPath = path.join(FIXTURES, 'captions.vtt');
fs.writeFileSync(vttPath, toVtt());
const slidesBase64 = makePdf(SLIDE_LINES).toString('base64');
const audio = process.env.E2E_SKIP_AUDIO ? { skip: 'E2E_SKIP_AUDIO set' } : makeLectureVideos();

// ─── Servers ─────────────────────────────────────────────────────────────────
const mediaServer = http.createServer((req, res) => {
  const file = path.join(MEDIA_ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(MEDIA_ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'video/mp4' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => mediaServer.listen(0, '127.0.0.1', r));
const MEDIA_URL = `http://127.0.0.1:${mediaServer.address().port}`;

const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
const serverProc = spawn(process.execPath, ['src/server.js'], {
  cwd: ROOT,
  env: { ...process.env, SERVER_PORT: String(port), OBSIDIAN_VAULT_PATH: VAULT, OBSIDIAN_SUBFOLDER: 'E2E', FORCE_COLOR: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
serverProc.stdout.on('data', (d) => { serverLog += d; });
serverProc.stderr.on('data', (d) => { serverLog += d; });

try {
  await waitFor(async () => (await request('GET', `${BASE}/health`)).status === 200, 15_000, 'server to start');

  // ─── Server ────────────────────────────────────────────────────────────────
  await step('health reports a valid model config', async () => {
    const { json } = await request('GET', `${BASE}/health`);
    check(json.ok, 'ok flag');
    check(!json.llm.error, `llm config error: ${json.llm.error}`);
    check(json.llm.model, 'model reported');
  });

  await step('configured model exists at the provider (npm run models)', async () => {
    const r = await run(['src/models.js', '--filter', resolveLLMConfig().model]);
    check(r.code === 0, `models.js exited ${r.code}:\n${r.out}`);
  });

  await step('origin guard: websites blocked, extension allowed', async () => {
    const evil = await request('POST', `${BASE}/generate`, { body: { transcript: 'x' }, headers: { Origin: 'https://evil.example' } });
    check(evil.status === 403, `evil origin got ${evil.status}`);
    const ext = await request('GET', `${BASE}/health`, { headers: { Origin: 'chrome-extension://abcdef' } });
    check(ext.status === 200 && ext.headers['access-control-allow-origin'] === 'chrome-extension://abcdef', 'extension origin allowed');
  });

  let firstNotesPath;
  await step('/generate: VTT captions + slides PDF → notes', async () => {
    const r = await request('POST', `${BASE}/generate`, {
      body: { transcript: toVtt(), course: 'CS201', topic: 'Merge Sort', slidesBase64 },
    });
    check(r.status === 200, `HTTP ${r.status}: ${r.raw}`);
    check(r.json.slidesChars > 0, 'slides text was extracted and sent');
    check(r.json.notesPath.startsWith(path.join(VAULT, 'E2E', 'CS201')), `unexpected path ${r.json.notesPath}`);
    firstNotesPath = r.json.notesPath;
    assertNotes(fs.readFileSync(firstNotesPath, 'utf8'));
  });

  await step('/generate: SRT captions, same course/topic/day does not overwrite', async () => {
    const r = await request('POST', `${BASE}/generate`, { body: { transcript: toSrt(), course: 'CS201', topic: 'Merge Sort' } });
    check(r.status === 200, `HTTP ${r.status}: ${r.raw}`);
    check(r.json.notesPath !== firstNotesPath, 'second lecture got a distinct filename');
    check(fs.existsSync(firstNotesPath), 'first notes file still exists');
    assertNotes(fs.readFileSync(r.json.notesPath, 'utf8'));
  });

  await step('/generate: caption file with no text → 400, no model call', async () => {
    const r = await request('POST', `${BASE}/generate`, { body: { transcript: 'WEBVTT\n\n', course: 'CS201' } });
    check(r.status === 400 && /empty/i.test(r.json?.error), `HTTP ${r.status}: ${r.raw}`);
  });

  await step('/generate-from-video: finds the audio stream, transcribes, writes notes', async () => {
    if (audio.skip) return skip(audio.skip);
    // The "player" only requested the silent camera stream (s0q0); the server must derive s1q0.
    const r = await request('POST', `${BASE}/generate-from-video`, {
      body: {
        videoUrls: [`${MEDIA_URL}/lesson1/s0q0.mp4?Policy=abc`],
        cookies: [{ name: 'CloudFront-Policy', value: 'abc', domain: '127.0.0.1' }],
        course: 'CS201',
        topic: 'From Video',
        lessonUrl: 'https://echo360.org/lesson/G_e2e-lesson/classroom',
      },
    });
    check(r.status === 200, `HTTP ${r.status}: ${r.raw}`);
    const transcript = fs.readFileSync(r.json.rawTranscriptPath, 'utf8');
    check(/merge sort/i.test(transcript), `transcript looks wrong: ${transcript.slice(0, 120)}`);
    assertNotes(fs.readFileSync(r.json.notesPath, 'utf8'));
    check(/audio: no/.test(serverLog) && /audio: yes/.test(serverLog), 'probed the silent stream before the audio stream');
  });

  await step('/generate-from-video: no stream reachable → clear error', async () => {
    const r = await request('POST', `${BASE}/generate-from-video`, {
      body: { videoUrls: [`${MEDIA_URL}/missing/s0q0.mp4`], course: 'CS201' },
    });
    check(r.status === 500 && /None of the captured/.test(r.json?.error), `HTTP ${r.status}: ${r.raw}`);
  });

  // ─── CLI ───────────────────────────────────────────────────────────────────
  await step('CLI: multi-chunk transcript merges into one well-formed note', async () => {
    const out = path.join(TMP, 'cli-chunked');
    const r = await run(
      ['src/index.js', '--transcript', vttPath, '--course', 'CS201', '--topic', 'Chunked', '-o', out],
      { LLM_CHUNK_CHARS: '600', LLM_MAX_OUTPUT_TOKENS: process.env.LLM_MAX_OUTPUT_TOKENS || '2500' },
    );
    check(r.code === 0, `exit ${r.code}:\n${r.out}`);
    check(/splitting into [2-9] chunks/.test(r.out), 'transcript was actually chunked');
    const md = readOnlyNote(out);
    assertNotes(md);
    check((md.match(/^tags:/gm) ?? []).length === 1, 'exactly one frontmatter block');
    check((md.match(/^# /gm) ?? []).length === 1, 'exactly one # title');
  });

  await step('CLI: video file → ffmpeg extraction → transcription → notes', async () => {
    if (audio.skip) return skip(audio.skip);
    const out = path.join(TMP, 'cli-video');
    const r = await run(['src/index.js', '--file', path.join(LESSON_MEDIA, 's1q0.mp4'), '--course', 'CS201', '--save-transcript', '-o', out]);
    check(r.code === 0, `exit ${r.code}:\n${r.out}`);
    check(/Extracting audio/.test(r.out), 'audio was extracted before upload');
    check(fs.readdirSync(out).some((f) => f.endsWith('.transcript.txt')), 'transcript saved');
    assertNotes(readOnlyNote(out));
  });

  await step('CLI: misconfiguration fails fast with an actionable message', async () => {
    const a = await run(['src/index.js', '--transcript', vttPath, '--provider', 'nope']);
    check(a.code === 1 && /Unknown LLM_PROVIDER/.test(a.out), `unknown provider: exit ${a.code} ${a.out}`);
    const b = await run(['src/index.js', '--transcript', vttPath], { LLM_PROVIDER: 'custom', LLM_BASE_URL: '', LLM_MODEL: 'x' });
    check(b.code === 1 && /LLM_BASE_URL/.test(b.out), `custom w/o base URL: exit ${b.code} ${b.out}`);
    const c = await run(['src/index.js', '--course', 'x']);
    check(c.code === 1, `missing input should exit 1, got ${c.code}`);
  });
} finally {
  serverProc.kill();
  mediaServer.close();
}

// ─── Report ──────────────────────────────────────────────────────────────────
const failed = results.filter((r) => r.status === 'FAIL');
console.log('\n' + results.map((r) => `${r.status.padEnd(4)}  ${r.name}${r.note ? `  (${r.note})` : ''}`).join('\n'));
console.log(`\n${results.length - failed.length}/${results.length} passed. Generated notes are in ${TMP}`);
if (failed.length) {
  console.log('\n── server log ──\n' + serverLog.split('\n').slice(-60).join('\n'));
  process.exitCode = 1;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function makeLectureVideos() {
  const has = (cmd) => spawnSync('which', [cmd]).status === 0;
  if (!has('ffmpeg') || !has('ffprobe')) return { skip: 'ffmpeg/ffprobe not installed' };

  const speech = path.join(FIXTURES, has('say') ? 'speech.aiff' : 'speech.wav');
  const tts = has('say') ? ['say', ['-o', speech, LECTURE_TEXT]]
    : has('espeak-ng') ? ['espeak-ng', ['-w', speech, LECTURE_TEXT]]
    : has('espeak') ? ['espeak', ['-w', speech, LECTURE_TEXT]]
    : null;
  if (!tts) return { skip: 'no text-to-speech tool (say / espeak-ng) to make test audio' };
  if (spawnSync(tts[0], tts[1]).status !== 0) return { skip: `${tts[0]} failed` };

  const ffmpeg = (args) => spawnSync('ffmpeg', ['-v', 'error', '-y', ...args]).status === 0;
  const silentOk = ffmpeg(['-f', 'lavfi', '-i', 'color=c=red:s=160x120:r=5', '-t', '5', '-c:v', 'mpeg4', path.join(LESSON_MEDIA, 's0q0.mp4')]);
  const audioOk = ffmpeg(['-f', 'lavfi', '-i', 'color=c=blue:s=160x120:r=5', '-i', speech, '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', path.join(LESSON_MEDIA, 's1q0.mp4')]);
  return silentOk && audioOk ? {} : { skip: 'ffmpeg could not build test videos' };
}

function assertNotes(md) {
  check(md.startsWith('---'), `notes should start with YAML frontmatter, got: ${JSON.stringify(md.slice(0, 80))}`);
  check(/^tags:/m.test(md), 'frontmatter has tags');
  check(/^# \S/m.test(md), 'has a # title');
  check(!md.startsWith('```'), 'not wrapped in a code fence');
  check(!/<think>/i.test(md), 'no leaked reasoning');
  check(/merge sort/i.test(md), 'mentions the lecture topic');
}

function readOnlyNote(dir) {
  const notes = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  check(notes.length === 1, `expected 1 note in ${dir}, found ${notes.length}`);
  return fs.readFileSync(path.join(dir, notes[0]), 'utf8');
}

async function step(name, fn) {
  const started = Date.now();
  process.stdout.write(`▶ ${name} ... `);
  try {
    const note = await fn();
    const status = note?.skipped ? 'SKIP' : 'PASS';
    results.push({ name, status, note: note?.reason });
    console.log(`${status} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (err) {
    results.push({ name, status: 'FAIL', note: err.message.split('\n')[0] });
    console.log(`FAIL (${((Date.now() - started) / 1000).toFixed(1)}s)\n   ${err.message}`);
  }
}

function skip(reason) {
  return { skipped: true, reason };
}

function check(cond, message) {
  if (!cond) throw new Error(message);
}

// Plain http instead of fetch: Node's fetch aborts if response headers take > 5 min,
// and the video pipeline can legitimately take that long.
function request(method, url, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(url, {
      method,
      headers: {
        ...(payload && { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json, raw: raw.slice(0, 2000) });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function run(args, env = {}) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, FORCE_COLOR: '0', ...env } });
    let out = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { out += d; });
    proc.on('close', (code) => resolve({ code, out }));
  });
}

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await fn()) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${what}\n${serverLog}`);
}

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function safe(fn) {
  try { return fn(); } catch (err) { return `(invalid: ${err.message})`; }
}
