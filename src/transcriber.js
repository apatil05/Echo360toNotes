import fs from 'fs';
import { createClient } from './providers.js';

/**
 * Transcribes an audio file with any OpenAI-compatible speech-to-text endpoint
 * (Groq Whisper by default — free tier: ~2 hours of audio / day).
 *
 * @param {string} audioPath - Absolute path to the audio file
 * @param {object} config    - Config from resolveTranscribeConfig()
 * @returns {Promise<string>} - Full transcript text
 */
export async function transcribeAudio(audioPath, config) {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  const { size } = fs.statSync(audioPath);
  if (size > config.maxBytes) {
    const mb = (n) => (n / 1024 / 1024).toFixed(1);
    throw new Error(`Audio file is ${mb(size)} MB — the transcription upload limit is ${mb(config.maxBytes)} MB (TRANSCRIBE_MAX_MB). Lecture is too long for this provider.`);
  }

  const client = createClient(config, { timeoutMs: 20 * 60_000 });

  const params = {
    file: fs.createReadStream(audioPath),
    model: config.model,
    response_format: 'json',
  };
  if (config.language) params.language = config.language;

  let result;
  try {
    result = await client.audio.transcriptions.create(params);
  } catch (err) {
    if (err.status === 404) {
      throw new Error(`Transcription model "${config.model}" isn't available on ${config.label}. Set TRANSCRIBE_MODEL.\n(${err.message})`, { cause: err });
    }
    throw err;
  }

  const text = typeof result === 'string' ? result : result?.text;
  if (!text || !text.trim()) {
    throw new Error('Transcription returned empty text. Is the audio file valid?');
  }

  return text.trim();
}
