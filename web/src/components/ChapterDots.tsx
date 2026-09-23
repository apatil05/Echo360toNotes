import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import './ChapterDots.css';

interface ChapterDotsProps {
  /** Section titles of the finished note. */
  chapters?: string[];
  /** While a job runs: how many parts are written, out of `total`. */
  filled?: number;
  total?: number;
  /** Course colour for filled dots. */
  style?: React.CSSProperties;
  className?: string;
}

const MAX_DOTS = 24;

/**
 * The signature component: one dot per chapter. Scrubbing across it (pointer
 * or arrow keys) previews each chapter title.
 */
export function ChapterDots({ chapters, filled, total, style, className }: ChapterDotsProps) {
  const tipId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<number | null>(null);

  const titles = chapters ?? [];
  const count = Math.min(MAX_DOTS, titles.length || total || 0);
  if (count === 0) return null;

  const live = filled !== undefined;
  const filledCount = live ? Math.min(count, Math.round(((filled ?? 0) / (total || count)) * count)) : count;
  const interactive = titles.length > 0;
  const label = interactive
    ? `${titles.length} chapter${titles.length === 1 ? '' : 's'}: ${titles.slice(0, 6).join(', ')}${titles.length > 6 ? ', …' : ''}`
    : `${filled ?? 0} of ${total ?? count} parts written`;

  const indexAt = (clientX: number) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return null;
    const ratio = Math.min(0.999, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.floor(ratio * count);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (interactive && e.pointerType !== 'touch') setActive(indexAt(e.clientX));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!interactive) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setActive((i) => {
        const cur = i ?? (e.key === 'ArrowRight' ? -1 : count);
        return Math.min(count - 1, Math.max(0, cur + (e.key === 'ArrowRight' ? 1 : -1)));
      });
    } else if (e.key === 'Escape') {
      setActive(null);
    }
  };

  return (
    <div
      ref={ref}
      className={['dots', live && 'dots-live', count > 14 && 'dots-dense', className].filter(Boolean).join(' ')}
      style={{ ...style, '--count': count } as React.CSSProperties}
      role={interactive ? 'group' : 'img'}
      aria-label={label}
      aria-describedby={active !== null ? tipId : undefined}
      tabIndex={interactive ? 0 : undefined}
      onPointerMove={onPointerMove}
      onPointerLeave={() => setActive(null)}
      onKeyDown={onKeyDown}
      onBlur={() => setActive(null)}
    >
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className={['dot', i < filledCount && 'is-filled', active === i && 'is-active'].filter(Boolean).join(' ')}
          aria-hidden="true"
        />
      ))}
      {active !== null && titles[active] && (
        <span
          id={tipId}
          role="tooltip"
          className="dots-tip"
          style={{ '--at': (active + 0.5) / count } as React.CSSProperties}
        >
          <span className="dots-tip-index tabular">{active + 1}</span>
          {titles[active]}
        </span>
      )}
    </div>
  );
}
