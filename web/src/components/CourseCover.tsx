import { coverStyle } from '../lib/courseColor';
import type { CoverColor } from '../data/types';
import './CourseCover.css';

/** A course's cover: a flat field of its colour with the code set large. */
export function CourseCover({ code, color, size = 'md', decorative = false }: {
  code: string;
  color: CoverColor;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  decorative?: boolean;
}) {
  return (
    <span
      className={`cover cover-${size}`}
      style={coverStyle(color)}
      aria-hidden={decorative || undefined}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : `${code} cover`}
    >
      {(size === 'md' || size === 'lg') && <span className="cover-code">{code}</span>}
    </span>
  );
}
