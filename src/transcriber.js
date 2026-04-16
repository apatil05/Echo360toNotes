import Groq from 'groq-sdk';
import fs from 'fs';

/**
 * Transcribes an audio file using Groq's Whisper large-v3 model.
 * Free tier: 7,200 audio seconds / day (~2 hours).
 *
 * @param {string} audioPath - Absolute path to the audio file
 * @param {string} apiKey    - Groq API key
 * @returns {Promise<string>} - Full transcript text
 */
export async function transcribeAudio(audioPath, apiKey) {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  const client = new Groq({ apiKey });

  const transcription = await client.audio.transcriptions.create({
    file: fs.createReadStream(audioPath),
    model: 'whisper-large-v3',
    response_format: 'verbose_json',  // includes word-level timestamps if needed later
    language: 'en',
  });

  // verbose_json returns { text, segments, ... }
  // plain 'json' or 'text' would also work — we just want the text
  const text = transcription.text ?? transcription;

  if (!text || text.trim().length === 0) {
    throw new Error('Transcription returned empty text. Is the audio file valid?');
  }

  return text.trim();
}
