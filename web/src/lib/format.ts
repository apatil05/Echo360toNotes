const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const dateYearFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

/** "Sep 16", with the year only when it isn't this year. `lecture_date` is a plain date. */
export function formatLectureDate(value: string): string {
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === new Date().getFullYear() ? dateFmt.format(date) : dateYearFmt.format(date);
}

/** 4512 -> "1:15:12", 754 -> "12:34". */
export function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds == null || seconds <= 0) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export function formatRelative(iso: string, now = Date.now()): string {
  const diff = (new Date(iso).getTime() - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day');
  const date = new Date(iso);
  return date.getFullYear() === new Date(now).getFullYear() ? dateFmt.format(date) : dateYearFmt.format(date);
}

export function greeting(date = new Date()): string {
  const h = date.getHours();
  if (h < 5) return 'Up late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export function firstName(displayName: string | null | undefined): string | null {
  const name = displayName?.trim().split(/\s+/)[0];
  return name || null;
}
