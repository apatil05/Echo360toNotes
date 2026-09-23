// Providers a student can bring a key for. Mirrors src/providers.js (the
// server-side presets) minus local-only ones: the hosted app can't reach a
// student's own Ollama. No provider is preselected anywhere in the UI.

export type ProviderId = 'groq' | 'openai' | 'nebius' | 'openrouter' | 'custom';

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  baseUrl: string | null;
  /** Suggested model when the provider's list includes it. */
  defaultModel: string | null;
  /** Can run Whisper, which lectures without captions need. */
  transcribes: boolean;
  keyUrl: string | null;
  keyHint: string;
  summary: string;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'openai/gpt-oss-120b',
    transcribes: true,
    keyUrl: 'https://console.groq.com/keys',
    keyHint: 'gsk_…',
    summary: 'Has a free tier. Also transcribes lectures without captions.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: null,
    transcribes: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'sk-…',
    summary: 'Paid. Also transcribes lectures without captions.',
  },
  {
    id: 'nebius',
    label: 'Nebius Token Factory',
    baseUrl: 'https://api.tokenfactory.nebius.com/v1',
    defaultModel: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
    transcribes: false,
    keyUrl: 'https://tokenfactory.nebius.com',
    keyHint: 'Your Nebius API key',
    summary: 'Open models such as Qwen. Needs a second key for lectures without captions.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: null,
    transcribes: false,
    keyUrl: 'https://openrouter.ai/keys',
    keyHint: 'sk-or-…',
    summary: 'One key for many models. Needs a second key for lectures without captions.',
  },
  {
    id: 'custom',
    label: 'Other (OpenAI-compatible)',
    baseUrl: null,
    defaultModel: null,
    transcribes: false,
    keyUrl: null,
    keyHint: 'Your API key',
    summary: 'Any server that speaks the OpenAI API over HTTPS.',
  },
];

export const TRANSCRIBE_PROVIDERS = PROVIDERS.filter((p) => p.transcribes);

export function providerById(id: string | null | undefined): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export type KeyTestResult =
  | { ok: true; models: string[] }
  | { ok: false; reason: 'rejected' | 'unreachable' | 'unexpected'; message: string };

/** Checks a key by listing the provider's models (all supported providers allow this from the browser). */
export async function testKey(baseUrl: string, key: string, signal?: AbortSignal): Promise<KeyTestResult> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers: { authorization: `Bearer ${key.trim()}` },
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    return { ok: false, reason: 'unreachable', message: "Couldn't reach the provider. Check the address and your connection." };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: 'rejected', message: 'The provider rejected this key. Copy it again and check nothing is missing.' };
  }
  if (!res.ok) {
    return { ok: false, reason: 'unexpected', message: `The provider answered with an error (HTTP ${res.status}). Try again in a minute.` };
  }
  const body = await res.json().catch(() => null);
  const models: string[] = Array.isArray(body?.data)
    ? body.data.map((m: { id?: unknown }) => String(m.id ?? '')).filter(Boolean).sort((a: string, b: string) => a.localeCompare(b))
    : [];
  return { ok: true, models };
}

/** Whisper models are listed alongside chat models; keep them out of the notes picker. */
export function chatModels(models: string[]): string[] {
  return models.filter((m) => !/whisper|tts|embedding|moderation|dall-e|image|audio|guard/i.test(m));
}
