import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTranscriptContent } from '../src/vttParser.js';
import { parsePdfBuffer } from '../src/slideParser.js';
import { LECTURE_TEXT, toVtt, toSrt, makePdf, SLIDE_LINES } from './fixtures.js';

test('VTT: keeps number-only and NOTE-prefixed captions, skips cue ids', () => {
  assert.equal(parseTranscriptContent(toVtt()), LECTURE_TEXT);
});

test('SRT: comma timestamps are parsed (used to return an empty transcript)', () => {
  assert.equal(parseTranscriptContent(toSrt()), LECTURE_TEXT);
});

test('VTT: skips header metadata and NOTE/STYLE blocks outside cues', () => {
  const vtt = [
    'WEBVTT - Lecture 12',
    'Kind: captions',
    '',
    'NOTE this comment block',
    'spans two lines',
    '',
    'STYLE',
    '::cue { color: red }',
    '',
    'intro-cue',
    '00:01.000 --> 00:04.000 align:start',
    '<v Professor>Hello <b>class</b></v>',
    '',
    '00:04.000 --> 00:05.000',
    'Hello class',
    '',
    '00:05.000 --> 00:06.000',
    'A &amp;lt; B &amp; C &gt; D',
  ].join('\n');
  assert.equal(parseTranscriptContent(vtt), 'Hello class A &lt; B & C > D');
});

test('handles BOM, CRLF and plain text', () => {
  assert.equal(parseTranscriptContent('﻿WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nHi there\r\n'), 'Hi there');
  assert.equal(parseTranscriptContent('  just some text  '), 'just some text');
  assert.equal(parseTranscriptContent(''), '');
});

test('Echo360 JSON shapes', () => {
  assert.equal(parseTranscriptContent(JSON.stringify({ words: [{ text: 'a' }, { text: 'b' }] })), 'a b');
  assert.equal(parseTranscriptContent(JSON.stringify({ transcript: [{ text: 'one' }, { content: 'two' }] })), 'one two');
  assert.equal(parseTranscriptContent(JSON.stringify(['x', { text: 'y' }])), 'x y');
});

test('unknown JSON (e.g. an error payload) yields no transcript instead of garbage', () => {
  assert.equal(parseTranscriptContent('{"error":"Not Found","status":404}'), '');
});

test('slides PDF text extraction works with pdf-parse v2', async () => {
  const text = await parsePdfBuffer(makePdf(SLIDE_LINES));
  assert.ok(text, 'expected extracted text');
  assert.match(text, /Divide and Conquer/);
  assert.match(text, /Theta\(n log n\)/);
  assert.doesNotMatch(text, /-- 1 of 1 --/);
});

test('image-only / near-empty PDF returns null', async () => {
  assert.equal(await parsePdfBuffer(makePdf(['hi'])), null);
});
