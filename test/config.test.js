import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveLLMConfig, resolveTranscribeConfig, assertReady } from '../src/providers.js';
import { localDate, sanitize, buildBaseName, uniqueBaseName, resolveOutputDir } from '../src/output.js';

const llm = (env, overrides) => resolveLLMConfig({ env, overrides });

test('defaults to Groq with a model that still exists', () => {
  const c = llm({ GROQ_API_KEY: 'g' });
  assert.equal(c.provider, 'groq');
  assert.equal(c.model, 'openai/gpt-oss-120b');
  assert.equal(c.apiKey, 'g');
  assert.doesNotThrow(() => assertReady(c));
});

test('blank env values count as unset', () => {
  const c = llm({ LLM_PROVIDER: '', LLM_MODEL: '  ', GROQ_API_KEY: 'g' });
  assert.equal(c.provider, 'groq');
  assert.equal(c.model, 'openai/gpt-oss-120b');
});

test('nebius preset reads NEBIUS_API_KEY and uses no chunk delay', () => {
  const c = llm({ LLM_PROVIDER: 'Nebius', NEBIUS_API_KEY: 'n', GROQ_API_KEY: 'g' });
  assert.equal(c.provider, 'nebius');
  assert.equal(c.apiKey, 'n');
  assert.equal(c.baseURL, 'https://api.tokenfactory.nebius.com/v1');
  assert.equal(c.chunkDelayMs, 0);
});

test('precedence: CLI override > LLM_* env > preset', () => {
  const env = { LLM_PROVIDER: 'nebius', NEBIUS_API_KEY: 'n', LLM_API_KEY: 'generic', LLM_MODEL: 'env-model' };
  assert.equal(llm(env).apiKey, 'generic');
  assert.equal(llm(env).model, 'env-model');
  assert.equal(llm(env, { model: 'cli-model', apiKey: 'cli-key' }).model, 'cli-model');
  assert.equal(llm(env, { model: 'cli-model', apiKey: 'cli-key' }).apiKey, 'cli-key');
});

test('missing settings produce actionable errors', () => {
  assert.throws(() => assertReady(llm({ LLM_PROVIDER: 'custom', LLM_MODEL: 'm' })), /LLM_BASE_URL/);
  assert.throws(() => assertReady(llm({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'k' })), /LLM_MODEL/);
  assert.throws(() => assertReady(llm({ LLM_PROVIDER: 'nebius' })), /NEBIUS_API_KEY or LLM_API_KEY/);
  assert.throws(() => llm({ LLM_PROVIDER: 'gemini' }), /Unknown LLM_PROVIDER/);
});

test('ollama needs no key', () => {
  assert.doesNotThrow(() => assertReady(llm({ LLM_PROVIDER: 'ollama', LLM_MODEL: 'llama3.1' })));
});

test('numeric tuning values are validated', () => {
  assert.equal(llm({ GROQ_API_KEY: 'g', LLM_CHUNK_CHARS: '25_000' }).chunkChars, 25000);
  assert.throws(() => llm({ LLM_CHUNK_CHARS: 'lots' }), /LLM_CHUNK_CHARS/);
  assert.throws(() => llm({ LLM_CHUNK_CHARS: '0' }), /greater than 0/);
  assert.equal(llm({ LLM_TEMPERATURE: 'default' }).temperature, null);
  assert.throws(() => llm({ LLM_TEMPERATURE: '5' }), /LLM_TEMPERATURE/);
});

test('transcription config', () => {
  const t = resolveTranscribeConfig({ env: { GROQ_API_KEY: 'g' } });
  assert.equal(t.model, 'whisper-large-v3');
  assert.equal(t.language, 'en');
  assert.equal(t.maxBytes, 25 * 1024 * 1024);
  assert.equal(resolveTranscribeConfig({ env: { TRANSCRIBE_LANGUAGE: '' } }).language, undefined);
  assert.equal(resolveTranscribeConfig({ env: { TRANSCRIBE_PROVIDER: 'openai', OPENAI_API_KEY: 'o' } }).model, 'whisper-1');
});

test('localDate uses the local calendar day, not UTC', () => {
  assert.equal(localDate(new Date(2026, 8, 14, 23, 59)), '2026-09-14');
  assert.equal(localDate(new Date(2026, 0, 1, 0, 1)), '2026-01-01');
});

test('sanitize keeps unicode letters and blocks path traversal', () => {
  assert.equal(sanitize('Физика 101'), 'Физика_101');
  assert.equal(sanitize('../../etc/passwd'), 'etc_passwd');
});

test('buildBaseName', () => {
  const date = '2026-09-14';
  assert.equal(buildBaseName({ course: 'CS 383', topic: 'Sorting!', date }), '2026-09-14_CS_383_Sorting');
  assert.equal(buildBaseName({ course: '???', date }), '2026-09-14');
  assert.equal(
    buildBaseName({ lessonUrl: 'https://echo360.org/lesson/G_abc-123/classroom?x=1#t', date }),
    '2026-09-14_G_abc-123',
  );
});

test('uniqueBaseName never overwrites an existing lecture', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-notes-test-'));
  try {
    assert.equal(uniqueBaseName(dir, 'a', ['.md']), 'a');
    fs.writeFileSync(path.join(dir, 'a.md'), '');
    assert.equal(uniqueBaseName(dir, 'a', ['.md']), 'a_2');
    fs.writeFileSync(path.join(dir, 'a_2.transcript.txt'), '');
    assert.equal(uniqueBaseName(dir, 'a', ['.md', '.transcript.txt']), 'a_3');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveOutputDir', () => {
  const env = { OBSIDIAN_VAULT_PATH: '/vault', OBSIDIAN_SUBFOLDER: 'Lectures' };
  assert.equal(resolveOutputDir({ course: 'CS383' }, env), path.resolve('/vault/Lectures/CS383'));
  assert.equal(resolveOutputDir({ course: '???' }, env), path.resolve('/vault/Lectures'));
  assert.equal(resolveOutputDir({ output: '/tmp/x', course: 'CS383' }, env), path.resolve('/tmp/x'));
});
