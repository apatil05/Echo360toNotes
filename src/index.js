#!/usr/bin/env node

import 'dotenv/config';
import { program } from 'commander';
import chalk from 'chalk';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

import { transcribeAudio } from './transcriber.js';
import { generateNotes } from './notesGenerator.js';
import { parseTranscriptContent } from './vttParser.js';
import { parsePdfFile } from './slideParser.js';
import { extractAudio } from './media.js';
import { LLM_PROVIDERS, resolveLLMConfig, resolveTranscribeConfig, assertReady, describe } from './providers.js';
import { localDate, resolveOutputDir, buildBaseName, uniqueBaseName } from './output.js';

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// Video containers always go through ffmpeg first — uploading a whole lecture video to
// the transcription API blows straight past its 25 MB limit.
const VIDEO_EXTS = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.ts']);

program
  .name('echo-notes')
  .description('Offline CLI for Echo360 Notes Converter — use the Chrome extension for live lectures')
  .version(version)
  .option('-f, --file <path>',       'Local audio/video file to transcribe')
  .option('-t, --transcript <path>', 'Saved transcript .txt/.vtt/.srt file to convert directly')
  .option('-c, --course <name>',     'Course name for frontmatter')
  .option('--topic <name>',          'Lecture topic override')
  .option('-o, --output <dir>',      'Output directory (overrides OBSIDIAN_VAULT_PATH)')
  .option('-s, --slides <path>',     'Lecture slides PDF to use alongside the transcript')
  .option('--save-transcript',       'Save the raw transcript next to the notes')
  .option('-p, --provider <name>',   `Notes model provider: ${Object.keys(LLM_PROVIDERS).join(', ')} (overrides LLM_PROVIDER)`)
  .option('-m, --model <id>',        'Notes model ID (overrides LLM_MODEL)')
  .option('--base-url <url>',        'OpenAI-compatible base URL (overrides LLM_BASE_URL)')
  .option('--api-key <key>',         'API key for the notes provider (overrides LLM_API_KEY / provider key)')
  .addHelpText('after', `
Examples:
  $ echo-notes --file lecture.mp3 --course "CS383" --topic "Sorting"
  $ echo-notes --transcript lecture.vtt --course "CS383"
  $ echo-notes --transcript lecture.vtt --slides slides.pdf --course "CS383"
  $ echo-notes --transcript lecture.vtt --provider nebius --model "Qwen/Qwen3-235B-A22B-Instruct-2507"

List the models your provider offers with:
  $ npm run models

For live Echo360 lectures, install the Chrome extension and run:
  $ npm start
`);

program.parse();

const opts = program.opts();

async function main() {
  if (!opts.file && !opts.transcript) {
    program.error('Error: provide --file or --transcript\nFor live Echo360 lectures, use the Chrome extension + `npm start`.');
  }

  const llm = resolveLLMConfig({
    overrides: { provider: opts.provider, model: opts.model, baseURL: opts.baseUrl, apiKey: opts.apiKey },
  });
  assertReady(llm);

  const slidesPath = opts.slides ? path.resolve(opts.slides) : null;
  if (slidesPath && !fs.existsSync(slidesPath)) throw new Error(`Slides file not found: ${slidesPath}`);

  const outputDir = resolveOutputDir(opts);
  fs.mkdirSync(outputDir, { recursive: true });
  console.log(chalk.gray(`   Output: ${outputDir}`));
  console.log(chalk.gray(`   Notes model: ${describe(llm)}`));

  let transcript = null;

  if (opts.transcript) {
    console.log(chalk.cyan('📄 Reading transcript file...'));
    const raw = fs.readFileSync(path.resolve(opts.transcript), 'utf8');
    transcript = parseTranscriptContent(raw);
  } else if (opts.file) {
    transcript = await transcribeFile(path.resolve(opts.file), llm);
  }

  if (!transcript) throw new Error('Transcript is empty — nothing readable was found in the input.');

  const wordCount = transcript.split(/\s+/).filter(Boolean).length;
  console.log(chalk.green(`   ${wordCount.toLocaleString()} words`));

  const suffixes = opts.saveTranscript ? ['.md', '.transcript.txt'] : ['.md'];
  const baseName = uniqueBaseName(outputDir, buildBaseName(opts), suffixes);

  if (opts.saveTranscript) {
    const tp = path.join(outputDir, baseName + '.transcript.txt');
    fs.writeFileSync(tp, transcript, 'utf8');
    console.log(chalk.gray(`   Transcript saved: ${tp}`));
  }

  let slides = null;
  if (slidesPath) {
    console.log(chalk.cyan(`📑 Extracting text from slides: ${path.basename(slidesPath)}...`));
    slides = await parsePdfFile(slidesPath);
    if (!slides) console.log(chalk.yellow('   No text extracted from slides PDF (image-only?). Proceeding without slides.'));
    else console.log(chalk.green(`   Extracted ${slides.length.toLocaleString()} chars from slides`));
  }

  console.log(chalk.cyan(`🤖 Generating notes with ${describe(llm)}...`));
  const notes = await generateNotes(transcript, llm, {
    course: opts.course,
    topic: opts.topic,
    slides,
    date: localDate(),
  });

  const notesPath = path.join(outputDir, baseName + '.md');
  fs.writeFileSync(notesPath, notes, 'utf8');

  console.log(chalk.bold.green(`\n✅ Notes saved to: ${notesPath}\n`));
}

async function transcribeFile(inputPath, llm) {
  if (!fs.existsSync(inputPath)) throw new Error(`File not found: ${inputPath}`);

  const base = resolveTranscribeConfig();
  // --api-key historically covered both Groq Whisper and Groq LLaMA; keep that when
  // both steps use the same provider.
  const config = opts.apiKey && base.provider === llm.provider ? { ...base, apiKey: opts.apiKey } : base;
  assertReady(config);

  const needsExtraction = VIDEO_EXTS.has(path.extname(inputPath).toLowerCase())
    || fs.statSync(inputPath).size > config.maxBytes;

  let audioPath = inputPath;
  if (needsExtraction) {
    audioPath = path.join(os.tmpdir(), `echo-notes-${crypto.randomBytes(6).toString('hex')}.opus`);
    console.log(chalk.cyan(`🎞️  Extracting audio from ${path.basename(inputPath)} with ffmpeg...`));
    await extractAudio(inputPath, audioPath);
  }

  try {
    console.log(chalk.cyan(`🎙️  Transcribing ${path.basename(inputPath)} with ${describe(config)}...`));
    return await transcribeAudio(audioPath, config);
  } finally {
    if (audioPath !== inputPath) fs.rmSync(audioPath, { force: true });
  }
}

main().catch(err => {
  console.error(chalk.red('\n❌ Error:'), err.message);
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
