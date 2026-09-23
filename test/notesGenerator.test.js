import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { generateNotes, generateNotesResumable, chunkTranscript, cleanModelOutput, mergeChunks } from '../src/notesGenerator.js';
import { resolveLLMConfig } from '../src/providers.js';
import { LECTURE_TEXT } from './fixtures.js';

// A tiny OpenAI-compatible server, so provider plumbing is tested without real API calls.
let server;
let baseURL;
let requests;
let respond;

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ url: req.url, body, auth: req.headers.authorization });
      const r = respond(body, requests.length);

      if (r.status && r.status !== 200) {
        res.writeHead(r.status, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: r.message } }));
      }

      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({
        id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 0, model: body.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`);
      const mid = Math.floor(r.content.length / 2);
      send({ role: 'assistant', content: r.content.slice(0, mid) });
      send({ content: r.content.slice(mid) });
      send({}, r.finish ?? 'stop');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${server.address().port}/v1`;
});

after(() => server.close());

beforeEach(() => {
  requests = [];
  respond = () => ({ content: '# Notes' });
});

const config = (env = {}) => resolveLLMConfig({
  env: { LLM_PROVIDER: 'custom', LLM_BASE_URL: baseURL, LLM_MODEL: 'test-model', LLM_API_KEY: 'sk-test', ...env },
});

test('sends the configured model/key/params and unwraps a fenced response', async () => {
  respond = () => ({ content: '```markdown\n---\ntags: [cs201]\n---\n# Merge Sort\n- body\n```' });
  const notes = await generateNotes(LECTURE_TEXT, config(), { course: 'CS201', date: '2026-09-14' });

  assert.equal(notes, '---\ntags: [cs201]\n---\n# Merge Sort\n- body');
  assert.equal(requests.length, 1);
  const [{ url, body, auth }] = requests;
  assert.equal(url, '/v1/chat/completions');
  assert.equal(auth, 'Bearer sk-test');
  assert.equal(body.model, 'test-model');
  assert.equal(body.max_tokens, 8192);
  assert.equal(body.temperature, 0.3);
  assert.equal(body.stream, true);
  assert.match(body.messages[1].content, /Course: CS201/);
});

test('multi-chunk: one frontmatter and one title in the merged notes', async () => {
  respond = (_body, n) => ({ content: `---\ntags: [x]\n---\n# Merge Sort\n## Section ${n}\n- point` });
  const llm = config({ LLM_CHUNK_CHARS: '300' });
  const expectedChunks = chunkTranscript(LECTURE_TEXT, 300).length;
  assert.ok(expectedChunks >= 3);

  const notes = await generateNotes(LECTURE_TEXT, llm, {});

  assert.equal(requests.length, expectedChunks);
  assert.match(requests[0].body.messages[0].content, /PART 1/);
  assert.match(requests.at(-1).body.messages[0].content, /FINAL PART/);
  assert.equal(notes.match(/^tags:/gm).length, 1);
  assert.equal(notes.match(/^# /gm).length, 1);
  assert.equal(notes.match(/^## Section/gm).length, expectedChunks);
});

test('resumable: pauses when out of time and resumes without repeating chunks', async () => {
  respond = (_body, n) => ({ content: `---\ntags: [x]\n---\n# Merge Sort\n## Section ${n}` });
  const llm = config({ LLM_CHUNK_CHARS: '300', LLM_CHUNK_DELAY_MS: '20' });
  const total = chunkTranscript(LECTURE_TEXT, 300).length;
  const saved = [];

  // First run: time for exactly two chunks, then the next pause doesn't fit.
  let budget = 2;
  const first = await generateNotesResumable(LECTURE_TEXT, llm, {}, {
    onPart: async (parts, n) => saved.push({ count: parts.length, n }),
    canContinue: (waitMs) => (waitMs === 0 || budget > 0) && budget-- > 0,
  });
  assert.equal(first.done, false);
  assert.equal(first.parts.length, 2);
  assert.equal(first.resumeAfterMs, 20);
  assert.deepEqual(saved, [{ count: 1, n: total }, { count: 2, n: total }]);
  assert.equal(requests.length, 2);

  // Second run: no pacing (the caller waited), finishes the rest.
  const second = await generateNotesResumable(LECTURE_TEXT, config({ LLM_CHUNK_CHARS: '300' }), {}, { parts: first.parts });
  assert.equal(second.done, true);
  assert.equal(requests.length, total);
  assert.match(requests[2].body.messages[1].content, new RegExp(`part 3 of ${total}`, 'i'));
  assert.equal(second.notes.match(/^# /gm).length, 1);
  assert.equal(second.notes.match(/^## Section/gm).length, total);
});

test('resumable: rejects progress saved with a different chunk size', async () => {
  await assert.rejects(
    generateNotesResumable('short lecture', config(), {}, { parts: ['a', 'b'] }),
    /chunk size/,
  );
});

test('falls back to max_completion_tokens when a model rejects max_tokens', async () => {
  respond = (body) => (body.max_tokens !== undefined
    ? { status: 400, message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." }
    : { content: '# ok' });

  assert.equal(await generateNotes('short lecture', config(), {}), '# ok');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.max_tokens, undefined);
  assert.equal(requests[1].body.max_completion_tokens, 8192);
});

test('drops temperature when a model only supports the default', async () => {
  respond = (body) => (body.temperature !== undefined
    ? { status: 400, message: "Unsupported value: 'temperature' does not support 0.3 with this model. Only the default (1) value is supported." }
    : { content: '# ok' });

  assert.equal(await generateNotes('short lecture', config(), {}), '# ok');
  assert.equal(requests[1].body.temperature, undefined);
});

test('unknown model error tells the user how to fix it', async () => {
  respond = () => ({ status: 404, message: 'The model `llama-3.3-70b-versatile` does not exist' });
  await assert.rejects(generateNotes('short lecture', config(), {}), /npm run models/);
});

test('output budget exhausted with no content is a clear error', async () => {
  respond = () => ({ content: '', finish: 'length' });
  await assert.rejects(generateNotes('short lecture', config(), {}), /LLM_MAX_OUTPUT_TOKENS/);
});

test('slides are truncated to LLM_MAX_SLIDES_CHARS', async () => {
  await generateNotes('short lecture', config({ LLM_MAX_SLIDES_CHARS: '20' }), { slides: 'S'.repeat(500) });
  const prompt = requests[0].body.messages[1].content;
  assert.match(prompt, /remaining slides truncated/);
  assert.ok(!prompt.includes('S'.repeat(21)));
});

test('empty transcript is rejected before calling the model', async () => {
  await assert.rejects(generateNotes('   ', config(), {}), /empty transcript/);
  assert.equal(requests.length, 0);
});

test('chunkTranscript never exceeds the limit, loses no words, and splits unpunctuated text', () => {
  for (const text of [LECTURE_TEXT, 'word '.repeat(500)]) {
    const chunks = chunkTranscript(text, 200);
    assert.ok(chunks.every((c) => c.length <= 200 && c.length > 0));
    assert.equal(chunks.join(' ').split(/\s+/).length, text.trim().split(/\s+/).length);
  }
});

test('cleanModelOutput strips reasoning but leaves inner code blocks alone', () => {
  assert.equal(cleanModelOutput('<think>hmm</think>\n# Title'), '# Title');
  assert.equal(
    cleanModelOutput('```\n---\ntags: [a]\ndate: 2026-09-14\n---\n```\n\n# Title\n- x'),
    '---\ntags: [a]\ndate: 2026-09-14\n---\n\n# Title\n- x',
  );
  assert.equal(cleanModelOutput('```yaml\n---\ntags: [a]\n---\n```\n# T'), '---\ntags: [a]\n---\n# T');
  const withCode = '# Title\n```js\nx()\n```';
  assert.equal(cleanModelOutput(withCode), withCode);
});

test('mergeChunks removes repeated frontmatter/title from later parts only', () => {
  const merged = mergeChunks(['---\na: 1\n---\n# T\n## One', '---\na: 1\n---\n# T\n## Two', '## Three']);
  assert.equal(merged, '---\na: 1\n---\n# T\n## One\n\n## Two\n\n## Three');
});
