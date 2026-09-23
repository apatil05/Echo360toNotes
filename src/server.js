#!/usr/bin/env node

import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import chalk from 'chalk';

import { generateNotes } from './notesGenerator.js';
import { transcribeAudio } from './transcriber.js';
import { parseTranscriptContent } from './vttParser.js';
import { parsePdfBuffer } from './slideParser.js';
import { downloadToFile, probeHasAudio, extractAudio } from './media.js';
import { resolveLLMConfig, resolveTranscribeConfig, assertReady, describe, ConfigError } from './providers.js';
import { localDate, resolveOutputDir, buildBaseName, uniqueBaseName } from './output.js';

const PORT = parseInt(process.env.SERVER_PORT || '3737', 10);
const { version: VERSION } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// Resolve provider settings once at startup. Problems are reported per request (and on
// /health) instead of crashing, so the extension popup can show what's wrong.
const llm = loadConfig(resolveLLMConfig);
const transcribe = loadConfig(resolveTranscribeConfig);

const app = express();

// Only the Chrome extension (and non-browser clients like curl) may call this server.
// A wide-open CORS policy would let any website you visit POST here and spend your
// API credits or write files into your vault.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin) return next();
  if (!origin.startsWith('chrome-extension://')) {
    return res.status(403).json({ error: `Origin ${origin} is not allowed` });
  }
  res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary', 'Origin');
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'GET, POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    return res.sendStatus(204);
  }
  next();
});

// 50 MB to accommodate base64-encoded PDF slide decks (a 10 MB PDF → ~13 MB base64)
app.use(express.json({ limit: '50mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, version: VERSION, llm: summarize(llm), transcribe: summarize(transcribe) });
});

app.post('/generate', async (req, res) => {
  const { transcript: rawTranscript, transcriptUrl, course, topic, lessonUrl, slidesBase64 } = req.body ?? {};

  try {
    const llmConfig = requireConfig(llm);
    let transcriptContent = rawTranscript;

    if (!transcriptContent && transcriptUrl) {
      assertHttpUrl(transcriptUrl);
      log(`Fetching transcript from ${transcriptUrl.slice(0, 80)}...`);
      const r = await fetch(transcriptUrl);
      if (!r.ok) throw new Error(`Transcript fetch failed: HTTP ${r.status}`);
      transcriptContent = await r.text();
    }

    if (!transcriptContent) {
      return res.status(400).json({ error: 'No transcript or transcriptUrl provided' });
    }

    const transcript = parseTranscriptContent(transcriptContent);
    if (!transcript) {
      return res.status(400).json({ error: 'Transcript was empty after parsing — the caption file had no readable text.' });
    }

    const slides = await parseSlidesFromRequest(slidesBase64);
    const result = await notesFromTranscript({ transcript, llmConfig, course, topic, lessonUrl, slides });
    res.json(result);
  } catch (err) {
    sendError(res, err);
  }
});

app.post('/generate-from-video', async (req, res) => {
  const { videoUrl, videoUrls, cookies, course, topic, lessonUrl, slidesBase64 } = req.body ?? {};

  const captured = [];
  if (Array.isArray(videoUrls)) captured.push(...videoUrls);
  if (videoUrl) captured.push(videoUrl);
  const validUrls = captured.filter(isHttpUrl);
  if (validUrls.length === 0) {
    return res.status(400).json({ error: 'No valid videoUrl(s) provided' });
  }

  const tmpFiles = [];
  const audioPath = path.join(os.tmpdir(), `echo360-${crypto.randomBytes(6).toString('hex')}.opus`);

  try {
    // Fail fast on bad config before spending minutes downloading video.
    const llmConfig = requireConfig(llm);
    const transcribeConfig = requireConfig(transcribe);

    const candidates = buildCandidateUrls(validUrls);
    log(`Searching for an audio stream across ${candidates.length} candidate URL(s)...`);

    const sourceMp4 = await findAudioSource(candidates, Array.isArray(cookies) ? cookies : [], lessonUrl, tmpFiles);
    if (!sourceMp4) {
      throw new Error('None of the captured stream files contained an audio track. Try a different lecture.');
    }
    log(chalk.green(`Audio source: ${path.basename(sourceMp4)}`));

    log('Extracting audio with ffmpeg (mono opus 16kbps)...');
    tmpFiles.push(audioPath);
    await extractAudio(sourceMp4, audioPath);
    const audioSizeMb = (fs.statSync(audioPath).size / 1024 / 1024).toFixed(1);
    log(chalk.green(`Extracted ${audioSizeMb} MB → ${audioPath}`));

    log(`Transcribing with ${describe(transcribeConfig)} (this can take a few minutes)...`);
    const transcript = await transcribeAudio(audioPath, transcribeConfig);
    log(chalk.green(`Transcript: ${countWords(transcript).toLocaleString()} words`));

    // Save the raw transcript next to the notes as a safety net so we never have to
    // re-download the video and burn another transcription quota slot.
    const outputDir = resolveOutputDir({ course });
    fs.mkdirSync(outputDir, { recursive: true });
    const baseName = uniqueBaseName(outputDir, buildBaseName({ course, topic, lessonUrl }), ['.md', '.transcript.txt']);
    const rawTranscriptPath = path.join(outputDir, baseName + '.transcript.txt');
    fs.writeFileSync(rawTranscriptPath, transcript, 'utf8');
    log(chalk.gray(`Saved raw transcript: ${rawTranscriptPath}`));

    const slides = await parseSlidesFromRequest(slidesBase64);
    const result = await notesFromTranscript({ transcript, llmConfig, course, topic, lessonUrl, slides, outputDir, baseName });
    res.json({ ...result, rawTranscriptPath });
  } catch (err) {
    sendError(res, err);
  } finally {
    for (const p of tmpFiles) fs.rmSync(p, { force: true });
  }
});

// Malformed JSON / oversized bodies: reply with JSON so the popup can show the reason.
app.use((err, _req, res, _next) => {
  const status = err.status ?? err.statusCode ?? 500;
  const message = err.type === 'entity.too.large'
    ? 'Request body too large (is the slides PDF over ~35 MB?)'
    : err.message;
  res.status(status).json({ error: message });
});

function buildCandidateUrls(captured) {
  const seen = new Set();
  const out = [];
  const add = (u) => {
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push(u);
  };

  // Derive low-quality stream variants from any captured URL. Priority order:
  // q0 first (smaller download), s0 first (most likely to contain audio).
  const variants = (url) => {
    if (!/s\dq\d\.mp4/i.test(url)) return [];
    const list = [];
    for (const q of [0, 1]) {
      for (const s of [0, 1, 2]) {
        list.push(url.replace(/s\dq\d\.mp4/i, `s${s}q${q}.mp4`));
      }
    }
    return list;
  };

  // Add derived low-quality variants from each captured URL FIRST so we try
  // small files before the big ones the player happened to grab.
  for (const u of captured) for (const v of variants(u)) add(v);
  // Then any captured URLs we haven't already covered (e.g. m3u8 manifests).
  for (const u of captured) add(u);
  return out;
}

async function findAudioSource(candidateUrls, cookies, lessonUrl, tmpFiles) {
  for (const url of candidateUrls) {
    const tmpPath = path.join(os.tmpdir(), `echo360-probe-${crypto.randomBytes(6).toString('hex')}.mp4`);
    tmpFiles.push(tmpPath);
    try {
      log(chalk.gray(`  → trying ${url.replace(/\?.*$/, '').slice(-40)}`));
      await downloadVideo(url, cookies, lessonUrl, tmpPath);
      const sizeMb = (fs.statSync(tmpPath).size / 1024 / 1024).toFixed(1);
      const hasAudio = await probeHasAudio(tmpPath);
      log(chalk.gray(`     ${sizeMb} MB, audio: ${hasAudio ? 'yes' : 'no'}`));
      if (hasAudio) return tmpPath;
    } catch (err) {
      log(chalk.gray(`     skip: ${err.message}`));
    }
    // Don't let silent camera/screen streams pile up on disk while we keep searching.
    fs.rmSync(tmpPath, { force: true });
  }
  return null;
}

async function parseSlidesFromRequest(slidesBase64) {
  if (!slidesBase64) return null;
  try {
    const buffer = Buffer.from(slidesBase64, 'base64');
    const text = await parsePdfBuffer(buffer);
    if (!text) {
      log(chalk.yellow('Slides PDF provided but no text could be extracted (image-only PDF?). Proceeding without slides.'));
      return null;
    }
    return text;
  } catch (err) {
    log(chalk.yellow(`Slides PDF parse failed: ${err.message}. Proceeding without slides.`));
    return null;
  }
}

async function notesFromTranscript({ transcript, llmConfig, course, topic, lessonUrl, slides, outputDir, baseName }) {
  const wordCount = countWords(transcript);
  log(chalk.green(`Parsed transcript: ${wordCount.toLocaleString()} words`));
  if (slides) log(chalk.green(`Slides: ${slides.length.toLocaleString()} chars of extracted text`));

  log(`Generating notes with ${describe(llmConfig)}...`);
  const notes = await generateNotes(transcript, llmConfig, {
    course,
    topic,
    slides,
    date: localDate(),
  });

  outputDir ??= resolveOutputDir({ course });
  fs.mkdirSync(outputDir, { recursive: true });
  baseName ??= uniqueBaseName(outputDir, buildBaseName({ course, topic, lessonUrl }), ['.md']);

  const filename = baseName + '.md';
  const notesPath = path.join(outputDir, filename);
  fs.writeFileSync(notesPath, notes, 'utf8');

  log(chalk.bold.green(`Saved: ${notesPath}`));
  return {
    ok: true,
    notesPath,
    wordCount,
    filename,
    slidesChars: slides?.length ?? 0,
    model: describe(llmConfig),
  };
}

async function downloadVideo(url, cookies, lessonUrl, destPath) {
  // Only send cookies scoped to the video's host; Echo360 sets same-named CloudFront
  // cookies on several domains and sending them all can get the request rejected.
  const host = new URL(url).hostname;
  const matching = cookies.filter((c) => {
    const domain = String(c.domain ?? '').replace(/^\./, '');
    return domain && (host === domain || host.endsWith('.' + domain));
  });
  const cookieHeader = (matching.length ? matching : cookies)
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  // Mirror what the Echo360 player sends so CloudFront treats us like the browser.
  const siteOrigin = isHttpUrl(lessonUrl) ? new URL(lessonUrl).origin : 'https://echo360.org';
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Referer': siteOrigin + '/',
    'Origin': siteOrigin,
  };
  if (cookieHeader) headers['Cookie'] = cookieHeader;

  await downloadToFile(url, headers, destPath);
}

app.listen(PORT, '127.0.0.1', () => {
  console.log(chalk.bold.cyan(`\n🎙️  Echo360 Notes server running`));
  console.log(chalk.gray(`   http://127.0.0.1:${PORT}`));
  console.log(chalk.gray(`   Vault: ${process.env.OBSIDIAN_VAULT_PATH || '(not set — using ./output)'}`));
  printConfig('Notes model', llm);
  printConfig('Transcription', transcribe);
  console.log(chalk.gray(`   Waiting for the Chrome extension to send transcripts...\n`));
});

function loadConfig(resolve) {
  try {
    const config = resolve();
    try {
      assertReady(config);
      return { config, error: null };
    } catch (err) {
      return { config, error: err.message };
    }
  } catch (err) {
    return { config: null, error: err.message };
  }
}

function requireConfig({ config, error }) {
  if (error) throw new ConfigError(error);
  return config;
}

function summarize({ config, error }) {
  return { provider: config?.provider ?? null, model: config?.model ?? null, error };
}

function printConfig(label, { config, error }) {
  const name = config ? describe(config) : '(invalid)';
  console.log(chalk.gray(`   ${label}: ${name}`) + (error ? chalk.yellow(`  ⚠️  ${error}`) : ''));
}

function sendError(res, err) {
  log(chalk.red(`Error: ${err.message}`));
  if (!res.headersSent) res.status(500).json({ error: err.message });
}

function isHttpUrl(u) {
  if (typeof u !== 'string') return false;
  try {
    return ['http:', 'https:'].includes(new URL(u).protocol);
  } catch {
    return false;
  }
}

function assertHttpUrl(u) {
  if (!isHttpUrl(u)) throw new Error('transcriptUrl must be an http(s) URL');
}

function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(chalk.gray(`[${ts}]`), msg);
}
