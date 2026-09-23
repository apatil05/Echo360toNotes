import { APP_NAME } from '../lib/brand';
import './Wordmark.css';

/** Placeholder mark: a lecture tile with its chapter dots. */
export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="wordmark">
      <svg className="wordmark-mark" viewBox="0 0 28 28" aria-hidden="true">
        <rect x="1" y="1" width="26" height="26" rx="8" className="wordmark-tile" />
        <rect x="7" y="8" width="14" height="3" rx="1.5" className="wordmark-line" />
        <circle cx="8.5" cy="18.5" r="2" className="wordmark-dot is-on" />
        <circle cx="14" cy="18.5" r="2" className="wordmark-dot is-on" />
        <circle cx="19.5" cy="18.5" r="2" className="wordmark-dot" />
      </svg>
      {!compact && <span className="wordmark-name">{APP_NAME}</span>}
    </span>
  );
}
