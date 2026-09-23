// Talks to the Chrome extension through `externally_connectable`, which only
// exposes chrome.runtime.sendMessage to origins the extension lists.
//
// Protocol (the extension implements the other side):
//   { type: 'PING' }                     -> { ok: true, version, linkedUserId | null }
//   { type: 'LINK', tokenHash, userId }  -> { ok: true } | { ok: false, error }

const EXTENSION_ID = import.meta.env.VITE_EXTENSION_ID as string | undefined;
export const EXTENSION_STORE_URL = (import.meta.env.VITE_EXTENSION_STORE_URL as string | undefined) || null;

/** Minimum extension version that supports linking. */
export const MIN_EXTENSION_VERSION = '2.0.0';

interface ChromeRuntime {
  sendMessage(extensionId: string, message: unknown, callback: (response: unknown) => void): void;
  lastError?: { message?: string };
}

function runtime(): ChromeRuntime | null {
  const chromeGlobal = (globalThis as { chrome?: { runtime?: ChromeRuntime } }).chrome;
  return chromeGlobal?.runtime?.sendMessage ? chromeGlobal.runtime : null;
}

export type BrowserSupport = 'chromium-desktop' | 'unsupported';

/** Extensions install in desktop Chromium browsers (Chrome, Edge, Brave, Arc). */
export function browserSupport(): BrowserSupport {
  const nav = navigator as Navigator & { userAgentData?: { brands?: { brand: string }[]; mobile?: boolean } };
  if (nav.userAgentData) {
    const chromium = nav.userAgentData.brands?.some((b) => /Chromium|Google Chrome/i.test(b.brand));
    return chromium && !nav.userAgentData.mobile ? 'chromium-desktop' : 'unsupported';
  }
  const ua = navigator.userAgent;
  const chromium = /Chrome\/\d+/.test(ua) && !/Mobile|Android|CriOS/i.test(ua);
  return chromium ? 'chromium-desktop' : 'unsupported';
}

function send<T>(message: unknown, timeoutMs = 1500): Promise<T | null> {
  const rt = runtime();
  if (!rt || !EXTENSION_ID) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    try {
      rt.sendMessage(EXTENSION_ID, message, (response) => {
        clearTimeout(timer);
        // lastError means the extension isn't installed (or is disabled).
        resolve(rt.lastError ? null : ((response as T) ?? null));
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

export interface ExtensionStatus {
  installed: boolean;
  version: string | null;
  linkedUserId: string | null;
  outdated: boolean;
}

export async function pingExtension(): Promise<ExtensionStatus> {
  const res = await send<{ ok?: boolean; version?: string; linkedUserId?: string | null }>({ type: 'PING' });
  if (!res?.ok) return { installed: false, version: null, linkedUserId: null, outdated: false };
  const version = res.version ?? null;
  return {
    installed: true,
    version,
    linkedUserId: res.linkedUserId ?? null,
    outdated: !version || compareVersions(version, MIN_EXTENSION_VERSION) < 0,
  };
}

export async function sendLinkCode(tokenHash: string, userId: string): Promise<{ ok: boolean; error?: string }> {
  const res = await send<{ ok?: boolean; error?: string }>({ type: 'LINK', tokenHash, userId }, 15000);
  if (!res) return { ok: false, error: "The extension didn't answer." };
  return { ok: Boolean(res.ok), error: res.error };
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

/** "Chrome on macOS" for the linked-browsers list. */
export function browserLabel(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Brave/.test(ua) ? 'Brave' : /OPR\//.test(ua) ? 'Opera' : 'Chrome';
  const os = /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'this computer';
  return `${browser} on ${os}`;
}
