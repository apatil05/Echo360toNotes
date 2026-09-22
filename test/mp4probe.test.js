import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

import { probeMp4 } from '../extension/lib/mp4probe.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0
  && spawnSync('ffprobe', ['-version']).status === 0;
const skip = hasFfmpeg ? false : 'ffmpeg/ffprobe not installed';

let dir;
const fixtures = {};

function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]);
  if (r.status !== 0) throw new Error(r.stderr.toString());
}

function audioPacketBytes(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'packet=size', '-of', 'csv=p=0', file]);
  return r.stdout.toString().trim().split('\n').filter(Boolean).reduce((sum, n) => sum + parseInt(n, 10), 0);
}

// Serves inclusive byte ranges from a file, like an HTTP server answering 206s.
function fileReader(file) {
  const buf = fs.readFileSync(file);
  return async (start, end) => ({
    bytes: new Uint8Array(buf.subarray(start, Math.min(end, buf.length - 1) + 1)),
    total: buf.length,
  });
}

before(() => {
  if (!hasFfmpeg) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp4probe-'));
  const video = ['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=3'];
  const audio = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3'];
  const vcodec = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'];
  const acodec = ['-c:a', 'aac', '-b:a', '64k'];

  fixtures.both = path.join(dir, 'both.mp4');
  ffmpeg([...video, ...audio, ...vcodec, ...acodec, '-shortest', fixtures.both]);
  fixtures.faststart = path.join(dir, 'faststart.mp4');
  ffmpeg([...video, ...audio, ...vcodec, ...acodec, '-shortest', '-movflags', '+faststart', fixtures.faststart]);
  fixtures.fragmented = path.join(dir, 'fragmented.mp4');
  ffmpeg([...audio, ...acodec, '-movflags', 'frag_keyframe+empty_moov', fixtures.fragmented]);
  fixtures.videoOnly = path.join(dir, 'video.mp4');
  ffmpeg([...video, ...vcodec, fixtures.videoOnly]);
  fixtures.audioOnly = path.join(dir, 'audio.mp4');
  ffmpeg([...audio, ...acodec, fixtures.audioOnly]);
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('finds the audio track and its exact payload size (moov after mdat)', { skip }, async () => {
  const info = await probeMp4(fileReader(fixtures.both));
  assert.equal(info.moovBeforeMdat, false);
  assert.equal(info.fragmented, false);
  assert.deepEqual(info.tracks.map(t => t.kind).sort(), ['audio', 'video']);
  const a = info.tracks.find(t => t.kind === 'audio');
  assert.equal(a.codec, 'mp4a');
  assert.equal(a.channels, 1);
  assert.equal(a.sampleRate, 44100);
  assert.ok(Math.abs(a.durationSec - 3) < 0.1);
  assert.equal(a.payloadBytes, audioPacketBytes(fixtures.both));
  assert.equal(info.totalBytes, fs.statSync(fixtures.both).size);
});

test('faststart files need only three small range reads', { skip }, async () => {
  const info = await probeMp4(fileReader(fixtures.faststart));
  assert.equal(info.moovBeforeMdat, true);
  assert.equal(info.rangeReads, 3); // ftyp header, moov header, moov body
  assert.equal(info.tracks.find(t => t.kind === 'audio').payloadBytes, audioPacketBytes(fixtures.faststart));
});

test('reports video-only and audio-only streams', { skip }, async () => {
  const v = await probeMp4(fileReader(fixtures.videoOnly));
  assert.deepEqual(v.tracks.map(t => t.kind), ['video']);
  assert.equal(v.tracks[0].codec, 'avc1');

  const a = await probeMp4(fileReader(fixtures.audioOnly));
  assert.deepEqual(a.tracks.map(t => t.kind), ['audio']);
});

test('fragmented files (like Echo360 streams) report unknown size, not zero', { skip }, async () => {
  const info = await probeMp4(fileReader(fixtures.fragmented));
  assert.equal(info.fragmented, true);
  const [a] = info.tracks;
  assert.equal(a.kind, 'audio');
  assert.equal(a.payloadBytes, null);
  assert.equal(a.durationSec, null);
});

test('rejects files without a moov box', async () => {
  const junk = new Uint8Array(32); // one zero-size box that runs to end of file
  junk.set([0, 0, 0, 32, 0x66, 0x72, 0x65, 0x65]); // 32-byte "free" box
  const read = async (s, e) => ({ bytes: junk.subarray(s, e + 1), total: junk.length });
  await assert.rejects(probeMp4(read), /No moov box/);
});
