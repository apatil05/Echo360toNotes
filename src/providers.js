import OpenAI from 'openai';

// Every provider here speaks the OpenAI-compatible API, so switching models is just
// a matter of pointing the OpenAI SDK at a different base URL.
//
// Resolution order for each setting: CLI flag → LLM_* env var → provider preset → DEFAULTS.

const LLM_DEFAULTS = {
  chunkChars: 60_000,
  chunkDelayMs: 0,
  maxOutputTokens: 8_192,
  maxSlidesChars: 40_000,
  temperature: 0.3,
  tokenParam: 'max_tokens',
};

export const LLM_PROVIDERS = {
  groq: {
    label: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    model: 'openai/gpt-oss-120b',
    // Free tier allows 8,000 tokens/minute and counts max_tokens against that budget,
    // so keep each request (prompt + max output) under the ceiling and pace chunks.
    chunkChars: 12_000,
    chunkDelayMs: 62_000,
    maxOutputTokens: 4_096,
    maxSlidesChars: 4_000,
  },
  nebius: {
    label: 'Nebius Token Factory',
    baseURL: 'https://api.tokenfactory.nebius.com/v1',
    apiKeyEnv: 'NEBIUS_API_KEY',
    model: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
  },
  openai: {
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    model: null,
    // Newer OpenAI models reject max_tokens in favour of max_completion_tokens.
    tokenParam: 'max_completion_tokens',
  },
  openrouter: {
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    model: null,
  },
  ollama: {
    label: 'Ollama (local)',
    baseURL: 'http://localhost:11434/v1',
    apiKeyEnv: null,
    requiresKey: false,
    model: null,
    chunkChars: 20_000,
  },
  custom: {
    label: 'Custom OpenAI-compatible endpoint',
    baseURL: null,
    apiKeyEnv: null,
    requiresKey: false,
    model: null,
  },
};

export const TRANSCRIBE_PROVIDERS = {
  groq: {
    label: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    model: 'whisper-large-v3',
  },
  openai: {
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    model: 'whisper-1',
  },
  custom: {
    label: 'Custom OpenAI-compatible endpoint',
    baseURL: null,
    apiKeyEnv: null,
    requiresKey: false,
    model: null,
  },
};

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Resolves the notes-generation model config. Never throws for missing values —
 * call assertReady() before using it so the server can still boot and report problems.
 */
export function resolveLLMConfig({ env = process.env, overrides = {} } = {}) {
  const provider = (pick(overrides.provider, env.LLM_PROVIDER) ?? 'groq').toLowerCase();
  const preset = LLM_PROVIDERS[provider];
  if (!preset) {
    throw new ConfigError(`Unknown LLM_PROVIDER "${provider}". Use one of: ${Object.keys(LLM_PROVIDERS).join(', ')}.`);
  }
  const p = { ...LLM_DEFAULTS, ...preset };

  return {
    kind: 'LLM',
    envPrefix: 'LLM',
    provider,
    label: p.label,
    baseURL: pick(overrides.baseURL, env.LLM_BASE_URL, p.baseURL),
    apiKey: pick(overrides.apiKey, env.LLM_API_KEY, p.apiKeyEnv && env[p.apiKeyEnv]),
    apiKeyEnv: p.apiKeyEnv,
    requiresKey: p.requiresKey !== false,
    model: pick(overrides.model, env.LLM_MODEL, p.model),
    chunkChars: positiveInt('LLM_CHUNK_CHARS', env.LLM_CHUNK_CHARS, p.chunkChars),
    chunkDelayMs: nonNegativeInt('LLM_CHUNK_DELAY_MS', env.LLM_CHUNK_DELAY_MS, p.chunkDelayMs),
    maxOutputTokens: positiveInt('LLM_MAX_OUTPUT_TOKENS', env.LLM_MAX_OUTPUT_TOKENS, p.maxOutputTokens),
    maxSlidesChars: nonNegativeInt('LLM_MAX_SLIDES_CHARS', env.LLM_MAX_SLIDES_CHARS, p.maxSlidesChars),
    temperature: parseTemperature(env.LLM_TEMPERATURE, p.temperature),
    reasoningEffort: pick(env.LLM_REASONING_EFFORT),
    tokenParam: p.tokenParam,
  };
}

/**
 * Resolves the speech-to-text config used when a lecture has no captions.
 * If the transcription provider matches the LLM provider, a CLI --api-key applies to both.
 */
export function resolveTranscribeConfig({ env = process.env, overrides = {} } = {}) {
  const provider = (pick(overrides.provider, env.TRANSCRIBE_PROVIDER) ?? 'groq').toLowerCase();
  const preset = TRANSCRIBE_PROVIDERS[provider];
  if (!preset) {
    throw new ConfigError(`Unknown TRANSCRIBE_PROVIDER "${provider}". Use one of: ${Object.keys(TRANSCRIBE_PROVIDERS).join(', ')}.`);
  }

  return {
    kind: 'Transcription',
    envPrefix: 'TRANSCRIBE',
    provider,
    label: preset.label,
    baseURL: pick(overrides.baseURL, env.TRANSCRIBE_BASE_URL, preset.baseURL),
    apiKey: pick(overrides.apiKey, env.TRANSCRIBE_API_KEY, preset.apiKeyEnv && env[preset.apiKeyEnv]),
    apiKeyEnv: preset.apiKeyEnv,
    requiresKey: preset.requiresKey !== false,
    model: pick(overrides.model, env.TRANSCRIBE_MODEL, preset.model),
    // Empty string = let the model auto-detect the language.
    language: env.TRANSCRIBE_LANGUAGE === undefined ? 'en' : pick(env.TRANSCRIBE_LANGUAGE),
    maxBytes: positiveInt('TRANSCRIBE_MAX_MB', env.TRANSCRIBE_MAX_MB, 25) * 1024 * 1024,
  };
}

/** Throws a ConfigError describing the first missing setting. */
export function assertReady(config) {
  const { kind, envPrefix, provider } = config;
  if (!config.baseURL) {
    throw new ConfigError(`${kind} provider "${provider}" needs a base URL — set ${envPrefix}_BASE_URL.`);
  }
  if (!config.model) {
    throw new ConfigError(`${kind} provider "${provider}" has no default model — set ${envPrefix}_MODEL.`);
  }
  if (config.requiresKey && !config.apiKey) {
    const vars = [config.apiKeyEnv, `${envPrefix}_API_KEY`].filter(Boolean).join(' or ');
    throw new ConfigError(`${kind} provider "${provider}" needs an API key — set ${vars} in .env.`);
  }
}

export function createClient(config, { timeoutMs = 10 * 60_000 } = {}) {
  assertReady(config);
  return new OpenAI({
    // Local servers like Ollama ignore the key, but the SDK insists on a non-empty value.
    apiKey: config.apiKey || 'not-needed',
    baseURL: config.baseURL,
    maxRetries: 2,
    timeout: timeoutMs,
  });
}

export function describe(config) {
  return `${config.provider} / ${config.model ?? '(no model set)'}`;
}

// Returns the first value that isn't undefined/null/blank. Blank .env lines like
// `LLM_MODEL=` should behave as "unset", not as an empty model name.
function pick(...values) {
  for (const v of values) {
    if (v === undefined || v === null || v === false) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return undefined;
}

function positiveInt(name, raw, fallback) {
  const n = nonNegativeInt(name, raw, fallback);
  if (n === 0) throw new ConfigError(`${name} must be greater than 0.`);
  return n;
}

function nonNegativeInt(name, raw, fallback) {
  const s = pick(raw);
  if (s === undefined) return fallback;
  const n = Number(s.replace(/_/g, ''));
  if (!Number.isInteger(n) || n < 0) throw new ConfigError(`${name} must be a whole number, got "${s}".`);
  return n;
}

// LLM_TEMPERATURE=default omits the parameter entirely (some reasoning models reject it).
function parseTemperature(raw, fallback) {
  const s = pick(raw);
  if (s === undefined) return fallback;
  if (s.toLowerCase() === 'default') return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > 2) throw new ConfigError(`LLM_TEMPERATURE must be between 0 and 2 (or "default"), got "${s}".`);
  return n;
}
