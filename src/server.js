#!/usr/bin/env node

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import chalk from 'chalk';

import { generateNotes } from './notesGenerator.js';
import { transcribeAudio } from './transcriber.js';
import { parseTranscriptContent } from './vttParser.js';
import { parsePdfBuffer } from './slideParser.js';

const PORT = parseInt(process.env.SERVER_PORT ?? '3737', 10);
const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';

const app = express();

app.use(cors());
// 50 MB to accommodate base64-encoded PDF slide decks (a 10 MB PDF → ~13 MB base64)
app.use(express.json({ limit: '50mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, version: '1.0.0' });
});

app.post('/generate', async (req, res) => {
  const { transcript: rawTranscript, transcriptUrl, course, topic, lessonUrl, slidesBase64 } = req.body ?? {};

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GROQ_API_KEY not set in server .env' });
  }

  try {
    let transcriptContent = rawTranscript;

    if (!transcriptContent && transcriptUrl) {
      log(`Fetching transcript from ${transcriptUrl.slice(0, 80)}...`);
      const r = await fetch(transcriptUrl);
      if (!r.ok) throw new Error(`Transcript fetch failed: HTTP ${r.status}`);
      transcriptContent = await r.text();
    }

    if (!transcriptContent) {
      return res.status(400).json({ error: 'No transcript or transcriptUrl provided' });
    }

    const transcript = parseTranscriptContent(transcriptContent);
    const slides = await parseSlidesFromRequest(slidesBase64);
    const result = await notesFromTranscript({ transcript, apiKey, course, topic, lessonUrl, slides });
    res.json(result);
  } catch (err) {
    log(chalk.red(`Error: ${err.message}`));
    res.status(500).json({ error: err.message });
  }
});

app.post('/generate-from-video', async (req, res) => {
  const { videoUrl, videoUrls, cookies, course, topic, lessonUrl, slidesBase64 } = req.body ?? {};

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GROQ_API_KEY not set in server .env' });
  }

  const captured = [];
  if (Array.isArray(videoUrls)) captured.push(...videoUrls);
  if (videoUrl) captured.push(videoUrl);
  if (captured.length === 0) {
    return res.status(400).json({ error: 'No videoUrl(s) provided' });
  }

  const candidates = buildCandidateUrls(captured);
  log(`Searching for an audio stream across ${candidates.length} candidate URL(s)...`);

  const tmpFiles = [];
  const audioPath = path.join(os.tmpdir(), `echo360-${crypto.randomBytes(6).toString('hex')}.opus`);

  try {
    const sourceMp4 = await findAudioSource(candidates, cookies ?? [], tmpFiles);
    if (!sourceMp4) {
      throw new Error('None of the captured stream files contained an audio track. Try a different lecture.');
    }
    log(chalk.green(`Audio source: ${path.basename(sourceMp4)}`));

    log('Extracting audio with ffmpeg (mono opus 16kbps)...');
    await extractAudio(sourceMp4, audioPath);
    tmpFiles.push(audioPath);
    const audioSizeMb = (fs.statSync(audioPath).size / 1024 / 1024).toFixed(1);
    log(chalk.green(`Extracted ${audioSizeMb} MB → ${audioPath}`));

    if (fs.statSync(audioPath).size > 25 * 1024 * 1024) {
      throw new Error(`Audio file is ${audioSizeMb} MB — Groq Whisper limit is 25 MB. Lecture is too long for free tier.`);
    }

    log('Transcribing with Groq Whisper large-v3 (this can take a few minutes)...');
    const transcript = await transcribeAudio(audioPath, apiKey);
    log(chalk.green(`Transcript: ${transcript.split(/\s+/).length.toLocaleString()} words`));

    // Save the raw transcript next to the notes as a safety net so we never have to
    // re-download the video and burn another Whisper quota slot.
    const rawTranscriptDir = resolveOutputDir({ course });
    fs.mkdirSync(rawTranscriptDir, { recursive: true });
    const rawTranscriptPath = path.join(
      rawTranscriptDir,
      buildFilename({ course, topic, lessonUrl }) + '.transcript.txt'
    );
    fs.writeFileSync(rawTranscriptPath, transcript, 'utf8');
    log(chalk.gray(`Saved raw transcript: ${rawTranscriptPath}`));

    const slides = await parseSlidesFromRequest(slidesBase64);
    const result = await notesFromTranscript({ transcript, apiKey, course, topic, lessonUrl, slides });
    res.json({ ...result, rawTranscriptPath });
  } catch (err) {
    log(chalk.red(`Error: ${err.message}`));
    res.status(500).json({ error: err.message });
  } finally {
    for (const p of tmpFiles) {
      try { fs.unlinkSync(p); } catch {}
    }
  }
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

async function findAudioSource(candidateUrls, cookies, tmpFiles) {
  for (const url of candidateUrls) {
    const tmpPath = path.join(os.tmpdir(), `echo360-probe-${crypto.randomBytes(6).toString('hex')}.mp4`);
    try {
      log(chalk.gray(`  → trying ${url.replace(/\?.*$/, '').slice(-40)}`));
      await downloadVideo(url, cookies, tmpPath);
      tmpFiles.push(tmpPath);
      const sizeMb = (fs.statSync(tmpPath).size / 1024 / 1024).toFixed(1);
      const hasAudio = await probeHasAudio(tmpPath);
      log(chalk.gray(`     ${sizeMb} MB, audio: ${hasAudio ? 'yes' : 'no'}`));
      if (hasAudio) return tmpPath;
    } catch (err) {
      log(chalk.gray(`     skip: ${err.message}`));
    }
  }
  return null;
}

function probeHasAudio(filePath) {
  return new Promise((resolve) => {
    const proc = spawn(FFPROBE, [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=codec_type',
      '-of', 'default=nw=1:nk=1',
      filePath,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', (c) => { out += c.toString(); });
    proc.on('error', () => resolve(false));
    proc.on('close', () => resolve(out.trim().includes('audio')));
  });
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

async function notesFromTranscript({ transcript, apiKey, course, topic, lessonUrl, slides }) {
  const wordCount = transcript.split(/\s+/).length;
  log(chalk.green(`Parsed transcript: ${wordCount.toLocaleString()} words`));
  if (slides) log(chalk.green(`Slides: ${slides.length.toLocaleString()} chars of extracted text`));

  log('Generating notes with LLaMA 3.3 70B...');
  const notes = await generateNotes(transcript, apiKey, {
    course,
    topic,
    slides,
    date: new Date().toISOString().split('T')[0],
  });

  const outputDir = resolveOutputDir({ course });
  fs.mkdirSync(outputDir, { recursive: true });

  const filename = buildFilename({ course, topic, lessonUrl }) + '.md';
  const notesPath = path.join(outputDir, filename);
  fs.writeFileSync(notesPath, notes, 'utf8');

  log(chalk.bold.green(`Saved: ${notesPath}`));
  return { ok: true, notesPath, wordCount, filename };
}

async function downloadVideo(url, cookies, destPath) {
  const cookieHeader = cookies
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  const headers = {
    // Mirror what the Echo360 player sends so CloudFront treats us like the browser.
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Referer': 'https://echo360.org/',
    'Origin': 'https://echo360.org',
  };
  if (cookieHeader) headers['Cookie'] = cookieHeader;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Video download failed: HTTP ${res.status} ${res.statusText}`);
  }

  // Stream the body straight to disk so we don't buffer a full lecture in RAM.
  const file = fs.createWriteStream(destPath);
  await new Promise((resolve, reject) => {
    const reader = res.body.getReader();
    const pump = () => reader.read().then(({ done, value }) => {
      if (done) { file.end(); return; }
      file.write(Buffer.from(value));
      pump();
    }).catch(reject);
    file.on('finish', resolve);
    file.on('error', reject);
    pump();
  });
}

function extractAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', inputPath,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'libopus',
      '-b:a', '16k',
      outputPath,
    ];
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.split('\n').slice(-5).join('\n')}`));
    });
  });
}

app.listen(PORT, '127.0.0.1', () => {
  console.log(chalk.bold.cyan(`\n🎙️  Echo360 Notes server running`));
  console.log(chalk.gray(`   http://127.0.0.1:${PORT}`));
  console.log(chalk.gray(`   Vault: ${process.env.OBSIDIAN_VAULT_PATH ?? '(not set — using ./output)'}`));
  console.log(chalk.gray(`   Waiting for the Chrome extension to send transcripts...\n`));
});

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  console.log(chalk.gray(`[${ts}]`), msg);
}

function resolveOutputDir({ course }) {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultPath) return path.resolve('./output');

  const parts = [vaultPath];
  const subfolder = process.env.OBSIDIAN_SUBFOLDER;
  if (subfolder) parts.push(subfolder);
  if (course) parts.push(sanitize(course));

  return path.resolve(path.join(...parts));
}

function buildFilename({ course, topic, lessonUrl }) {
  const date = new Date().toISOString().split('T')[0];
  const parts = [date];
  if (course) parts.push(sanitize(course));
  if (topic) parts.push(sanitize(topic));
  if (parts.length === 1 && lessonUrl) {
    const slug = lessonUrl.split('/').filter(Boolean).pop()?.slice(0, 30) ?? 'lecture';
    parts.push(sanitize(slug));
  }
  return parts.join('_');
}

function sanitize(str) {
  return str.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}
