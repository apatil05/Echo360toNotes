// Reads an MP4's track layout through byte-range requests, without downloading the
// media. Used by the audio diagnostics page to find which Echo360 stream carries
// audio and how large that audio is on its own.
//
// readRange(start, end) must resolve to { bytes: Uint8Array, total: number } for the
// inclusive byte range [start, end]; `total` is the full file size.

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'mvex']);
const HANDLER_KINDS = { soun: 'audio', vide: 'video', text: 'text', sbtl: 'text', subt: 'text' };
const MAX_TOP_LEVEL_BOXES = 64;

const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const u64 = (b, o) => u32(b, o) * 2 ** 32 + u32(b, o + 4);

/** Parses a box header at `offset`; returns null when fewer than 8 bytes remain. */
function readHeader(b, offset, end) {
  if (offset + 8 > end) return null;
  let size = u32(b, offset);
  const type = fourcc(b, offset + 4);
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > end) return null;
    size = u64(b, offset + 8);
    headerSize = 16;
  } else if (size === 0) {
    size = end - offset;
  }
  return { size, type, headerSize };
}

function* children(b, start, end) {
  let offset = start;
  while (offset < end) {
    const h = readHeader(b, offset, end);
    if (!h || h.size < h.headerSize) return;
    yield { ...h, start: offset + h.headerSize, end: Math.min(offset + h.size, end) };
    offset += h.size;
  }
}

function parseTrak(b, start, end) {
  const track = { kind: 'other', handler: null, codec: null, durationSec: null, sampleCount: null, payloadBytes: null };
  const walk = (s, e) => {
    for (const box of children(b, s, e)) {
      const p = box.start;
      if (CONTAINERS.has(box.type)) walk(p, box.end);
      else if (box.type === 'hdlr') {
        track.handler = fourcc(b, p + 8);
        track.kind = HANDLER_KINDS[track.handler] ?? 'other';
      } else if (box.type === 'mdhd') {
        const v1 = b[p] === 1;
        const timescale = u32(b, p + (v1 ? 20 : 12));
        const duration = v1 ? u64(b, p + 24) : u32(b, p + 16);
        if (timescale) track.durationSec = duration / timescale;
      } else if (box.type === 'stsd') {
        const entry = p + 8;
        if (entry + 8 <= box.end) track.codec = fourcc(b, entry + 4).trim();
        if (entry + 36 <= box.end) {
          track.channels = u16(b, entry + 24);
          track.sampleRate = u32(b, entry + 32) >>> 16;
        }
      } else if (box.type === 'stsz') {
        const sampleSize = u32(b, p + 4);
        const count = u32(b, p + 8);
        track.sampleCount = count;
        if (sampleSize) {
          track.payloadBytes = sampleSize * count;
        } else if (p + 12 + count * 4 <= box.end) {
          let sum = 0;
          for (let i = 0; i < count; i++) sum += u32(b, p + 12 + i * 4);
          track.payloadBytes = sum;
        }
      }
    }
  };
  walk(start, end);
  if (track.kind !== 'audio') {
    delete track.channels;
    delete track.sampleRate;
  }
  return track;
}

/** Parses a complete `moov` box (including its header). */
export function parseMoov(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const top = readHeader(b, 0, b.length);
  if (!top || top.type !== 'moov') throw new Error('Not a moov box');
  const tracks = [];
  let fragmented = false;
  let timescale = null;
  let fragmentDuration = null;
  for (const box of children(b, top.headerSize, Math.min(top.size, b.length))) {
    if (box.type === 'trak') tracks.push(parseTrak(b, box.start, box.end));
    if (box.type === 'mvhd') timescale = u32(b, box.start + (b[box.start] === 1 ? 20 : 12));
    if (box.type === 'mvex') {
      fragmented = true;
      for (const child of children(b, box.start, box.end)) {
        if (child.type === 'mehd') fragmentDuration = b[child.start] === 1 ? u64(b, child.start + 4) : u32(b, child.start + 4);
      }
    }
  }
  if (fragmented) {
    // Fragmented files keep their samples in moof boxes, so the moov sample
    // tables are empty: sizes are unknown here, and durations are known only
    // when the optional mehd box is present.
    const movieSec = fragmentDuration && timescale ? fragmentDuration / timescale : null;
    for (const t of tracks) {
      if (!t.sampleCount) t.payloadBytes = null;
      if (!t.durationSec) t.durationSec = movieSec;
    }
  }
  return { tracks, fragmented };
}

/**
 * Walks the top-level boxes with small range reads and parses `moov`.
 * Resolves to { totalBytes, moovBytes, moovBeforeMdat, fragmented, tracks, rangeReads }.
 */
export async function probeMp4(readRange, { maxMoovBytes = 64 * 1024 * 1024 } = {}) {
  let offset = 0;
  let total = Infinity;
  let rangeReads = 0;
  let sawMdat = false;
  let fragmented = false;

  for (let i = 0; i < MAX_TOP_LEVEL_BOXES && offset < total; i++) {
    const head = await readRange(offset, offset + 15);
    rangeReads++;
    total = head.total;
    const h = readHeader(head.bytes, 0, head.bytes.length);
    if (!h || h.size < h.headerSize) break;

    if (h.type === 'moov') {
      if (h.size > maxMoovBytes) throw new Error(`moov box is ${h.size} bytes, over the ${maxMoovBytes} byte cap`);
      const moov = await readRange(offset, offset + h.size - 1);
      rangeReads++;
      const parsed = parseMoov(moov.bytes);
      return {
        totalBytes: total,
        moovBytes: h.size,
        moovBeforeMdat: !sawMdat,
        fragmented: fragmented || parsed.fragmented,
        tracks: parsed.tracks,
        rangeReads,
      };
    }
    if (h.type === 'mdat') sawMdat = true;
    if (h.type === 'moof') fragmented = true;
    offset += h.size;
  }
  throw new Error(`No moov box found in the first ${MAX_TOP_LEVEL_BOXES} top-level boxes`);
}
