import fs from 'fs';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

const FFMPEG = () => process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
const FFPROBE = () => process.env.FFPROBE_PATH?.trim() || 'ffprobe';

/** Streams a URL to disk (with backpressure). Removes the partial file on failure. */
export async function downloadToFile(url, headers, destPath) {
  const res = await fetch(url, { headers });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
  }
  try {
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));
  } catch (err) {
    fs.rmSync(destPath, { force: true });
    throw err;
  }
}

export function probeHasAudio(filePath) {
  return new Promise((resolve) => {
    const proc = spawn(FFPROBE(), [
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

/** Extracts mono 16 kHz / 16 kbps Opus — ~7 MB per hour, well under Whisper's 25 MB cap. */
export function extractAudio(inputPath, outputPath) {
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
    const proc = spawn(FFMPEG(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (err) => reject(new Error(`Could not run ffmpeg (${err.message}). Install ffmpeg or set FFMPEG_PATH.`)));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.split('\n').slice(-5).join('\n')}`));
    });
  });
}
