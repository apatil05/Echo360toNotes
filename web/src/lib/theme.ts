import { useSyncExternalStore } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'appearance';
const listeners = new Set<() => void>();
const media = window.matchMedia('(prefers-color-scheme: dark)');

function read(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'dark' || value === 'system' || value === 'light') return value;
  } catch {
    // Storage can be unavailable (private windows); light is the default.
  }
  return 'light';
}

function apply(pref: ThemePreference) {
  const dark = pref === 'dark' || (pref === 'system' && media.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#141418' : '#fcfcfd');
}

let current = read();
apply(current);
media.addEventListener('change', () => {
  if (current === 'system') apply(current);
});

export function setThemePreference(pref: ThemePreference) {
  current = pref;
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // Still applies for this visit.
  }
  apply(pref);
  listeners.forEach((l) => l());
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}
