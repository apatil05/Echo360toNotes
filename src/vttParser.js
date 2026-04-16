/**
 * Converts a WebVTT (.vtt) file string into clean plain text.
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
 * This strips all timestamps and metadata, deduplicates overlapping cues,
 * and returns a single clean paragraph-style string.
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

    // Skip the WEBVTT header and NOTE/STYLE/REGION blocks
    if (line === 'WEBVTT' || line.startsWith('NOTE') || line.startsWith('STYLE') || line.startsWith('REGION')) {
      inCue = false;
      continue;
    }

    // Timestamp line (e.g. "00:00:01.000 --> 00:00:04.500 ...")
    if (/^\d{2}:\d{2}[\d:.]+\s+-->\s+/.test(line)) {
      inCue = true;
      continue;
    }

    // Blank line resets cue state
    if (line === '') {
      inCue = false;
      continue;
    }

    // Skip cue ID lines (pure numbers or UUIDs that precede timestamps)
    if (/^\d+$/.test(line) || /^[0-9a-f-]{36}$/i.test(line)) {
      continue;
    }

    if (inCue) {
      // Strip inline VTT tags like <c>, <v Speaker>, <b>, <i>, timestamps
      const text = line
        .replace(/<[^>]+>/g, '')   // remove all VTT tags
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .trim();

      if (text && text !== lastLine) {
        textLines.push(text);
        lastLine = text;
      }
    }
  }

  // Join into paragraphs — add a line break when there's a natural sentence boundary
  return textLines
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parses raw transcript content — handles both VTT and Echo360 JSON formats.
 * Call this with content already fetched (e.g. from inside the browser session).
 *
 * @param {string} content - Raw transcript content (VTT or JSON string)
 * @returns {string} - Plain text transcript
 */
export function parseTranscriptContent(content) {
  if (!content || !content.trim()) return '';

  // Try JSON first (Echo360 /transcript API returns JSON)
  if (content.trim().startsWith('{') || content.trim().startsWith('[')) {
    try {
      const json = JSON.parse(content);
      return parseEcho360TranscriptJSON(json);
    } catch {
      // fall through to VTT parser
    }
  }

  // VTT format
  if (content.includes('WEBVTT') || /\d{2}:\d{2}.*-->/.test(content)) {
    return parseVTT(content);
  }

  // Plain text fallback
  return content.trim();
}

/**
 * Parses the Echo360 JSON transcript API response into plain text.
 * Handles multiple known response shapes.
 */
function parseEcho360TranscriptJSON(data) {
  const lines = [];

  // Shape 1: { words: [{ text, ... }] }
  if (Array.isArray(data?.words)) {
    return data.words.map(w => w.text ?? '').join(' ').replace(/\s+/g, ' ').trim();
  }

  // Shape 2: { transcript: [{ text }] } or { data: [{ text }] }
  const items = data?.transcript ?? data?.data ?? data?.captions ?? [];
  if (Array.isArray(items)) {
    for (const item of items) {
      const text = item?.text ?? item?.content ?? item?.caption ?? '';
      if (text) lines.push(text.trim());
    }
    if (lines.length > 0) return lines.join(' ').replace(/\s+/g, ' ').trim();
  }

  // Shape 3: flat array of strings
  if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item === 'string') lines.push(item.trim());
      else if (item?.text) lines.push(item.text.trim());
    }
    if (lines.length > 0) return lines.join(' ').replace(/\s+/g, ' ').trim();
  }

  // Last resort: stringify and strip JSON syntax
  return JSON.stringify(data)
    .replace(/[{}\[\]"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
