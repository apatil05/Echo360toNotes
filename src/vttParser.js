// Cue timing line for both WebVTT ("00:01.000 --> ...", "00:00:01.000 --> ...")
// and SRT ("00:00:01,000 --> ..."), which the extension also captures.
const TIMESTAMP_LINE = /^(?:\d+:)?\d{1,2}:\d{2}[.,]\d{3}\s+-->\s+/;

/**
 * Converts a WebVTT (.vtt) or SubRip (.srt) caption file into clean plain text.
 *
 * VTT format looks like:
 *   WEBVTT
 *
 *   00:00:01.000 --> 00:00:04.500
 *   Hello and welcome to today's lecture.
 *
 *   00:00:05.000 --> 00:00:08.000
 *   Today we'll be covering geological time.
 *
 * Only text inside a cue (after a timing line, before the next blank line) is kept,
 * so headers, NOTE/STYLE/REGION blocks and cue identifiers are skipped — while caption
 * text that happens to be a bare number ("1945") or start with "NOTE" is preserved.
 *
 * @param {string} vttContent
 * @returns {string}
 */
export function parseVTT(vttContent) {
  const lines = vttContent.split(/\r?\n/);
  const textLines = [];
  let inCue = false;
  let lastLine = '';

  for (const raw of lines) {
    const line = raw.trim();

    if (TIMESTAMP_LINE.test(line)) {
      inCue = true;
      continue;
    }

    // Blank line ends the cue
    if (line === '') {
      inCue = false;
      continue;
    }

    if (!inCue) continue;

    // Strip inline VTT tags like <c>, <v Speaker>, <b>, <i>, timestamps
    const text = line
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&') // last, so "&amp;lt;" decodes to "&lt;" not "<"
      .trim();

    if (text && text !== lastLine) {
      textLines.push(text);
      lastLine = text;
    }
  }

  return textLines
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parses raw transcript content — handles VTT, SRT, Echo360 JSON and plain text.
 * Call this with content already fetched (e.g. from inside the browser session).
 *
 * @param {string} content - Raw transcript content
 * @returns {string} - Plain text transcript ('' if nothing readable was found)
 */
export function parseTranscriptContent(content) {
  if (!content || !content.trim()) return '';
  const trimmed = content.replace(/^﻿/, '').trim();

  // Try JSON first (Echo360 /transcript API returns JSON)
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const json = JSON.parse(trimmed);
      return parseEcho360TranscriptJSON(json);
    } catch {
      // fall through to caption parser
    }
  }

  if (trimmed.startsWith('WEBVTT') || /\d{2}:\d{2}[.,]\d{3}\s+-->/.test(trimmed)) {
    return parseVTT(trimmed);
  }

  // Plain text fallback
  return trimmed;
}

const TEXT_KEYS = ['text', 'content', 'caption'];

/**
 * Parses the Echo360 JSON transcript API response into plain text.
 * Handles multiple known response shapes.
 */
function parseEcho360TranscriptJSON(data) {
  const join = (arr) => arr.join(' ').replace(/\s+/g, ' ').trim();
  const textOf = (item) => {
    if (typeof item === 'string') return item;
    for (const k of TEXT_KEYS) if (typeof item?.[k] === 'string') return item[k];
    return '';
  };

  // Shape 1: { words: [{ text, ... }] }
  if (Array.isArray(data?.words)) {
    return join(data.words.map(textOf));
  }

  // Shape 2: { transcript: [{ text }] } / { data: [...] } / { captions: [...] }
  // Shape 3: flat array of strings or { text } objects
  const items = Array.isArray(data) ? data : (data?.transcript ?? data?.data ?? data?.captions);
  if (Array.isArray(items)) {
    return join(items.map(textOf).filter(Boolean));
  }

  // Unknown shape (often an error payload like {"error":"not found"}). Returning the
  // stringified JSON here used to make the model write notes about the error message.
  return '';
}
