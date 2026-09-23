import fs from 'fs';
import path from 'path';

/** Today's date as YYYY-MM-DD in the machine's local timezone (not UTC). */
export function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function resolveOutputDir({ course, output } = {}, env = process.env) {
  if (output) return path.resolve(output);

  const vaultPath = env.OBSIDIAN_VAULT_PATH?.trim();
  if (!vaultPath) return path.resolve('./output');

  const parts = [vaultPath];
  const subfolder = env.OBSIDIAN_SUBFOLDER?.trim();
  if (subfolder) parts.push(subfolder);
  const courseDir = course ? sanitize(course) : '';
  if (courseDir) parts.push(courseDir);

  return path.resolve(path.join(...parts));
}

export function buildBaseName({ course, topic, lessonUrl, date = localDate() }) {
  const parts = [date, course, topic].map((p) => (p ? sanitize(p) : '')).filter(Boolean);
  if (parts.length === 1 && lessonUrl) {
    const slug = lessonSlug(lessonUrl);
    if (slug) parts.push(slug);
  }
  return parts.join('_');
}

/**
 * Returns a base name that doesn't collide with any existing `<base><suffix>` file in dir,
 * appending _2, _3, ... so two lectures on the same day never overwrite each other.
 */
export function uniqueBaseName(dir, base, suffixes) {
  const taken = (b) => suffixes.some((s) => fs.existsSync(path.join(dir, b + s)));
  if (!taken(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`;
    if (!taken(candidate)) return candidate;
  }
}

export function sanitize(str) {
  return String(str)
    .replace(/[^\p{L}\p{N}_-]/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

// Echo360 lesson URLs look like https://echo360.org/lesson/<id>/classroom — the id is
// the only part that identifies the lecture.
function lessonSlug(lessonUrl) {
  const id = lessonUrl.match(/\/lesson\/([^/?#]+)/i)?.[1];
  const fallback = lessonUrl.replace(/[?#].*$/, '').split('/').filter(Boolean).pop();
  return sanitize((id ?? fallback ?? '').slice(0, 30));
}
