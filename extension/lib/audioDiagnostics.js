// Audio diagnostics: checks whether the extension can fetch Echo360 streams, which
// stream carries audio, how large that audio is, and what access rules (cookies,
// expiry, IP binding) apply. The report never contains cookie values or URL
// query values, so it is safe to paste into an issue or chat.

import { probeMp4 } from './mp4probe.js';

const STREAM_FILE = /s\dq\d\.mp4/i;
const WHISPER_LIMIT_MB = 25;
// Lambda re-encodes to mono 16 kbps Opus (see src/media.js); container overhead
// adds a little, so budget 17 kbps.
const OPUS_KBPS = 17;

const mb = (bytes) => (bytes == null ? null : Math.round((bytes / 1e6) * 100) / 100);

/** Same candidate order as the local server: low-quality variants first, s0 first. */
export function buildCandidateUrls(captured) {
  const out = [];
  const add = (u) => { if (u && !out.includes(u)) out.push(u); };
  for (const url of captured) {
    if (!STREAM_FILE.test(url)) continue;
    for (const q of [0, 1]) for (const s of [0, 1, 2]) add(url.replace(STREAM_FILE, `s${s}q${q}.mp4`));
  }
  for (const url of captured) add(url);
  return out;
}

/** host + last path segments + query parameter NAMES only. */
export function redactUrl(url) {
  try {
    const u = new URL(url);
    const tail = u.pathname.split('/').filter(Boolean).slice(-2).join('/');
    const params = [...u.searchParams.keys()];
    return `${u.host}/…/${tail}${params.length ? `?${params.map(p => `${p}=…`).join('&')}` : ''}`;
  } catch {
    return '(invalid url)';
  }
}

function decodeCloudFrontBase64(value) {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/');
  return atob(b64);
}

/**
 * Summarises a CloudFront policy (from a Policy query param or CloudFront-Policy
 * cookie) without exposing the resource path or IP address.
 */
export function describeCloudFrontPolicy(encoded, now = Date.now()) {
  try {
    const policy = JSON.parse(decodeCloudFrontBase64(encoded));
    const statement = policy.Statement?.[0] ?? {};
    const cond = statement.Condition ?? {};
    const expires = cond.DateLessThan?.['AWS:EpochTime'];
    const resource = String(statement.Resource ?? '');
    return {
      expiresInMin: expires ? Math.round((expires * 1000 - now) / 60000) : null,
      ipRestricted: Boolean(cond.IpAddress),
      wildcardResource: resource.includes('*'),
    };
  } catch {
    return { unreadable: true };
  }
}

/** Access rules visible in a URL's own query string. */
export function describeUrlSigning(url, now = Date.now()) {
  let params;
  try {
    params = new URL(url).searchParams;
  } catch {
    return { signed: false };
  }
  if (params.has('Policy')) return { signed: true, style: 'cloudfront-policy', ...describeCloudFrontPolicy(params.get('Policy'), now) };
  if (params.has('Expires') && params.has('Signature')) {
    return { signed: true, style: 'cloudfront-canned', expiresInMin: Math.round((Number(params.get('Expires')) * 1000 - now) / 60000), ipRestricted: false };
  }
  if (params.has('X-Amz-Signature')) {
    const date = params.get('X-Amz-Date');
    const ttl = Number(params.get('X-Amz-Expires'));
    let expiresInMin = null;
    if (date && ttl) {
      const start = Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8), +date.slice(9, 11), +date.slice(11, 13), +date.slice(13, 15));
      expiresInMin = Math.round((start + ttl * 1000 - now) / 60000);
    }
    return { signed: true, style: 's3-presigned', expiresInMin, ipRestricted: false };
  }
  return { signed: params.size > 0 ? 'unknown' : false, paramNames: [...params.keys()] };
}

/** Cookie NAMES per domain, plus any CloudFront policy they carry. */
export function describeCookies(cookies, now = Date.now()) {
  const byDomain = {};
  let cloudFrontPolicy = null;
  for (const c of cookies) {
    (byDomain[c.domain] ??= []).push(c.name);
    if (c.name === 'CloudFront-Policy' && !cloudFrontPolicy) cloudFrontPolicy = { domain: c.domain, ...describeCloudFrontPolicy(c.value, now) };
  }
  return { byDomain, cloudFrontPolicy };
}

async function rangeFetch(fetchImpl, url, start, end, credentials) {
  const controller = new AbortController();
  const res = await fetchImpl(url, { credentials, headers: { Range: `bytes=${start}-${end}` }, signal: controller.signal });
  if (!res.ok) {
    controller.abort();
    return { ok: false, status: res.status };
  }
  const contentType = res.headers.get('content-type');
  if (res.status === 206) {
    const total = Number(res.headers.get('content-range')?.split('/')[1]);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { ok: true, status: 206, ranged: true, total: Number.isFinite(total) ? total : null, bytes, contentType };
  }
  // Server ignored Range: don't download the whole video just to probe it.
  const length = Number(res.headers.get('content-length'));
  controller.abort();
  return { ok: true, status: res.status, ranged: false, total: Number.isFinite(length) && length > 0 ? length : null, contentType };
}

function summariseM3u8(text) {
  const lines = text.split(/\r?\n/);
  const durations = lines.filter(l => l.startsWith('#EXTINF:')).map(l => parseFloat(l.slice(8)));
  const segment = lines.find(l => l && !l.startsWith('#'));
  return {
    variants: lines.filter(l => l.startsWith('#EXT-X-STREAM-INF')).length,
    audioRenditions: lines.filter(l => l.startsWith('#EXT-X-MEDIA') && /TYPE=AUDIO/.test(l)).length,
    segments: durations.length,
    durationMin: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / 6) / 10 : null,
    segmentExt: segment ? (segment.split('?')[0].match(/\.(\w+)$/)?.[1] ?? null) : null,
  };
}

async function checkCandidate(fetchImpl, url, now) {
  const result = { url: redactUrl(url), captured: null, signing: describeUrlSigning(url, now) };
  const isManifest = /\.m3u8(\?|$)/i.test(url);

  try {
    if (isManifest) {
      const res = await fetchImpl(url, { credentials: 'include' });
      result.withSession = { status: res.status };
      if (res.ok) result.manifest = summariseM3u8(await res.text());
    } else {
      const head = await rangeFetch(fetchImpl, url, 0, 15, 'include');
      result.withSession = { status: head.status, rangeSupported: head.ranged ?? null, contentType: head.contentType ?? null };
      if (head.ok) {
        result.fileMB = mb(head.total);
        if (head.ranged) {
          const read = async (s, e) => {
            const r = await rangeFetch(fetchImpl, url, s, e, 'include');
            if (!r.ok || !r.ranged) throw new Error(`range read failed (HTTP ${r.status})`);
            return r;
          };
          const info = await probeMp4(read);
          result.mp4 = {
            moovBeforeMdat: info.moovBeforeMdat,
            fragmented: info.fragmented,
            rangeReads: info.rangeReads,
            tracks: info.tracks.map(t => ({
              kind: t.kind,
              codec: t.codec,
              durationMin: t.durationSec == null ? null : Math.round(t.durationSec / 6) / 10,
              payloadMB: mb(t.payloadBytes),
              ...(t.kind === 'audio' ? {
                channels: t.channels,
                sampleRate: t.sampleRate,
                kbps: t.payloadBytes && t.durationSec ? Math.round((t.payloadBytes * 8) / t.durationSec / 1000) : null,
              } : {}),
            })),
          };
        }
      }
    }
  } catch (err) {
    result.withSession = { ...(result.withSession ?? {}), error: err.message };
  }

  // Would a server with no Echo360 session get in? (Doesn't test IP binding.)
  if (result.withSession?.status >= 200 && result.withSession.status < 300) {
    try {
      const bare = isManifest
        ? await fetchImpl(url, { credentials: 'omit' }).then(r => ({ status: r.status }))
        : await rangeFetch(fetchImpl, url, 0, 15, 'omit');
      result.withoutSession = { status: bare.status };
    } catch (err) {
      result.withoutSession = { error: err.message };
    }
  }
  return result;
}

/** Turns per-candidate results into the answers the hosted design needs. */
export function summarise(results, cookieInfo) {
  const reachable = results.filter(r => r.withSession?.status >= 200 && r.withSession.status < 300);
  const withAudio = reachable
    .map(r => ({ r, audio: r.mp4?.tracks.find(t => t.kind === 'audio') }))
    .filter(x => x.audio);
  withAudio.sort((a, b) => (a.r.fileMB ?? Infinity) - (b.r.fileMB ?? Infinity));
  const best = withAudio[0];

  const needsSession = reachable.length === 0 ? null
    : reachable.every(r => r.withoutSession && !(r.withoutSession.status >= 200 && r.withoutSession.status < 300));
  // The CloudFront cookie's expiry only matters if the streams actually need it.
  const expiries = [
    ...reachable.map(r => r.signing.expiresInMin),
    needsSession === false ? null : cookieInfo?.cloudFrontPolicy?.expiresInMin,
  ].filter(n => typeof n === 'number');
  const manifestMin = Math.max(0, ...reachable.map(r => r.manifest?.durationMin ?? 0)) || null;
  const unsignedUrls = reachable.length > 0 && reachable.every(r => r.signing.signed !== true);
  const ipRestricted = reachable.some(r => r.signing.ipRestricted) || Boolean(cookieInfo?.cloudFrontPolicy?.ipRestricted);

  const summary = {
    streamsTried: results.length,
    streamsReachable: reachable.length,
    rangeRequestsWork: reachable.some(r => r.withSession.rangeSupported),
    serverWithoutSessionBlocked: needsSession,
    ipRestricted,
    accessExpiresInMin: expiries.length ? Math.min(...expiries) : null,
    audio: null,
    verdict: [],
  };

  if (best) {
    const { r, audio } = best;
    const audioOnlyStream = r.mp4.tracks.every(t => t.kind !== 'video');
    const durationMin = audio.durationMin || manifestMin;
    // Fragmented files don't list sample sizes up front; an audio-only file is
    // (almost) all audio, so its size stands in.
    const audioTrackMB = audio.payloadMB ?? (audioOnlyStream ? r.fileMB : null);
    const kbps = audio.kbps ?? (audioTrackMB && durationMin ? Math.round((audioTrackMB * 8000) / (durationMin * 60)) : null);
    const opusMB = durationMin ? Math.round(((durationMin * 60 * OPUS_KBPS) / 8 / 1000) * 10) / 10 : null;
    summary.audio = {
      stream: r.url,
      audioOnlyStream,
      codec: audio.codec,
      channels: audio.channels,
      durationMin,
      durationSource: audio.durationMin ? 'mp4' : durationMin ? 'hls-playlist' : null,
      kbps,
      audioTrackMB,
      audioSizeSource: audio.payloadMB != null ? 'sample-table' : audioTrackMB != null ? 'file-size' : null,
      wholeFileMB: r.fileMB,
      moovBeforeMdat: r.mp4.moovBeforeMdat,
      fragmented: r.mp4.fragmented,
      reencodedOpusMB: opusMB,
      fitsWhisperAfterReencode: opusMB == null ? null : opusMB <= WHISPER_LIMIT_MB,
      fitsWhisperAsIs: audioTrackMB == null ? null : audioTrackMB <= WHISPER_LIMIT_MB,
    };
  }

  const v = summary.verdict;
  if (!reachable.length) {
    v.push('FAIL: the extension could not fetch any stream. Press play on the lecture, then rerun.');
    return summary;
  }
  if (!best) {
    v.push('FAIL: no reachable MP4 stream had an audio track (or none supported range requests). Check the per-stream results.');
  } else if (summary.audio.audioOnlyStream) {
    v.push(`OK: an audio-only stream exists (${summary.audio.wholeFileMB} MB). The extension can upload it to S3 as is.`);
  } else {
    v.push(`OK: audio is inside a video stream (${summary.audio.wholeFileMB} MB file, ${summary.audio.audioTrackMB} MB of audio). ` +
      'Upload only the audio track (extract it in the browser) instead of the whole file.');
  }
  if (summary.audio?.fitsWhisperAsIs === false) {
    v.push(`NOTE: the raw audio (${summary.audio.audioTrackMB} MB) is over Whisper's ${WHISPER_LIMIT_MB} MB limit. ` +
      `Lambda must re-encode it (≈${summary.audio.reencodedOpusMB ?? '?'} MB as 16 kbps Opus)` +
      (summary.audio.fitsWhisperAfterReencode === false ? ' and split it into chunks, since it is still over the limit.' : '.'));
  }
  if (summary.audio && summary.audio.fitsWhisperAsIs == null) v.push('NOTE: audio size or duration unknown. Check the per-stream results.');
  if (needsSession === false) {
    v.push('NOTE: streams load WITHOUT your session. A server could fetch them directly (IP binding not tested).');
    if (unsignedUrls) v.push('NOTE: stream URLs carry no signature, so the URL itself grants access. Treat captured URLs as secrets.');
  }
  if (needsSession === true) v.push('CONFIRMED: streams need your Echo360 session, so the browser has to do the download.');
  if (ipRestricted) v.push('CONFIRMED: access is locked to your IP address. Only your browser can download.');
  if (summary.accessExpiresInMin != null) v.push(`NOTE: stream access expires in ~${summary.accessExpiresInMin} min, so the upload must finish inside that window.`);
  return summary;
}

/** Runs every check. `state` is the background tab state; `cookies` the raw cookie list. */
export async function runDiagnostics({ state, cookies = [], fetchImpl = fetch, now = Date.now(), onProgress = () => {} }) {
  const captured = [...(state?.videoUrls ?? []), state?.videoUrl].filter(Boolean);
  const candidates = buildCandidateUrls(captured);
  const capturedSet = new Set(captured);
  const cookieInfo = describeCookies(cookies, now);

  const results = [];
  for (const [i, url] of candidates.entries()) {
    onProgress(`Checking stream ${i + 1} of ${candidates.length}…`);
    const r = await checkCandidate(fetchImpl, url, now);
    r.captured = capturedSet.has(url);
    results.push(r);
  }

  return {
    generatedAt: new Date(now).toISOString(),
    hasCaptions: Boolean(state?.transcriptUrl),
    capturedStreams: captured.length,
    summary: summarise(results, cookieInfo),
    cookies: cookieInfo,
    streams: results,
  };
}
