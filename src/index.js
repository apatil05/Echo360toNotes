#!/usr/bin/env node

import 'dotenv/config';
import { program } from 'commander';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';

import { transcribeAudio } from './transcriber.js';
import { generateNotes } from './notesGenerator.js';
import { parseTranscriptContent } from './vttParser.js';
import { parsePdfFile } from './slideParser.js';

program
  .name('echo-notes')
  .description('Offline CLI for Echo360 Notes Converter — use the Chrome extension for live lectures')
  .version('2.0.0')
  .option('-f, --file <path>',       'Local audio/video file to transcribe with Whisper')
  .option('-t, --transcript <path>', 'Saved transcript .txt/.vtt file to convert directly')
  .option('-c, --course <name>',     'Course name for frontmatter')
  .option('--topic <name>',          'Lecture topic override')
  .option('-o, --output <dir>',      'Output directory (overrides OBSIDIAN_VAULT_PATH)')
  .option('-s, --slides <path>',      'Lecture slides PDF to use alongside the transcript')
  .option('--save-transcript',       'Save the raw transcript next to the notes')
  .option('--api-key <key>',         'Groq API key (overrides GROQ_API_KEY env var)')
  .addHelpText('after', `
Examples:
  $ echo-notes --file lecture.mp3 --course "CS383" --topic "Sorting"
  $ echo-notes --transcript lecture.vtt --course "CS383"
  $ echo-notes --transcript lecture.vtt --slides slides.pdf --course "CS383"

For live Echo360 lectures, install the Chrome extension and run:
  $ npm start
`);

program.parse();

const opts = program.opts();

async function main() {
  if (!opts.file && !opts.transcript) {
    console.error(chalk.red('Error: provide --file or --transcript'));
    console.error(chalk.gray('For live Echo360 lectures, use the Chrome extension + `npm start`.'));
    program.help(); // exits internally
  }

  const apiKey = opts.apiKey ?? process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error(chalk.red('Error: GROQ_API_KEY not set.'));
    process.exit(1);
  }

  const outputDir = resolveOutputDir(opts);
  fs.mkdirSync(outputDir, { recursive: true });
  console.log(chalk.gray(`   Output: ${outputDir}`));

  let transcript = null;

  if (opts.transcript) {
    console.log(chalk.cyan('📄 Reading transcript file...'));
    const raw = fs.readFileSync(path.resolve(opts.transcript), 'utf8');
    transcript = parseTranscriptContent(raw);
  } else if (opts.file) {
    const audioPath = path.resolve(opts.file);
    if (!fs.existsSync(audioPath)) throw new Error(`File not found: ${audioPath}`);
    console.log(chalk.cyan(`🎙️  Transcribing ${path.basename(audioPath)} with Groq Whisper...`));
    transcript = await transcribeAudio(audioPath, apiKey);
  }

  if (!transcript) throw new Error('No transcript available.');

  const wordCount = transcript.split(/\s+/).length;
  console.log(chalk.green(`   ${wordCount.toLocaleString()} words`));

  if (opts.saveTranscript) {
    const tp = path.join(outputDir, buildFilename(opts, 'transcript') + '.txt');
    fs.writeFileSync(tp, transcript, 'utf8');
    console.log(chalk.gray(`   Transcript saved: ${tp}`));
  }

  let slides = null;
  if (opts.slides) {
    const slidesPath = path.resolve(opts.slides);
    if (!fs.existsSync(slidesPath)) throw new Error(`Slides file not found: ${slidesPath}`);
    console.log(chalk.cyan(`📑 Extracting text from slides: ${path.basename(slidesPath)}...`));
    slides = await parsePdfFile(slidesPath);
    if (!slides) console.log(chalk.yellow('   No text extracted from slides PDF (image-only?). Proceeding without slides.'));
    else console.log(chalk.green(`   Extracted ${slides.length.toLocaleString()} chars from slides`));
  }

  console.log(chalk.cyan('🤖 Generating notes with LLaMA 3.3 70B...'));
  const notes = await generateNotes(transcript, apiKey, {
    course: opts.course,
    topic: opts.topic,
    slides,
    date: new Date().toISOString().split('T')[0],
  });

  const notesPath = path.join(outputDir, buildFilename(opts, 'notes') + '.md');
  fs.writeFileSync(notesPath, notes, 'utf8');

  console.log(chalk.bold.green(`\n✅ Notes saved to: ${notesPath}\n`));
}

function resolveOutputDir(opts) {
  if (opts.output) return path.resolve(opts.output);

  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultPath) return path.resolve('./output');

  const parts = [vaultPath];
  const subfolder = process.env.OBSIDIAN_SUBFOLDER;
  if (subfolder) parts.push(subfolder);
  if (opts.course) parts.push(sanitize(opts.course));

  return path.resolve(path.join(...parts));
}

function buildFilename(opts, type) {
  const date = new Date().toISOString().split('T')[0];
  const parts = [date];
  if (opts.course) parts.push(sanitize(opts.course));
  if (opts.topic) parts.push(sanitize(opts.topic));
  if (type === 'transcript') parts.push('transcript');
  return parts.join('_');
}

function sanitize(str) {
  return str.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

main().catch(err => {
  console.error(chalk.red('\n❌ Error:'), err.message);
  if (process.env.DEBUG) console.error(err);
  process.exit(1);
});
