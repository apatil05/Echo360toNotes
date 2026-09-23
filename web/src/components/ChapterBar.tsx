import { useEffect, useRef, useState } from 'react';
import { sectionId } from '../lib/sections';
import './ChapterBar.css';

/**
 * The reader's chapter bar: one segment per section, filled up to where you
 * are, like a podcast scrubber. Clicking a segment jumps to that section.
 */
export function ChapterBar({ chapters }: { chapters: string[] }) {
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (chapters.length === 0) return;
    const headings = chapters
      .map((title) => document.getElementById(sectionId(title)))
      .filter((el): el is HTMLElement => Boolean(el));
    if (!headings.length) return;

    // The active chapter is the last heading scrolled past the bar.
    const update = () => {
      const line = (ref.current?.getBoundingClientRect().bottom ?? 0) + 16;
      let index = 0;
      headings.forEach((el, i) => {
        if (el.getBoundingClientRect().top <= line) index = i;
      });
      setActive(index);
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [chapters]);

  if (chapters.length < 2) return null;

  return (
    <div className="chapterbar" ref={ref}>
      <nav aria-label="Chapters">
        <ol>
          {chapters.map((title, i) => (
            <li key={title + i} className={i <= active ? 'is-read' : undefined}>
              <a
                href={`#${sectionId(title)}`}
                aria-current={i === active ? 'location' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  document.getElementById(sectionId(title))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  setActive(i);
                }}
              >
                <span className="chapterbar-seg" aria-hidden="true" />
                <span className="chapterbar-name">{title}</span>
              </a>
            </li>
          ))}
        </ol>
      </nav>
      <p className="chapterbar-now tabular" aria-hidden="true">
        <span>{active + 1}/{chapters.length}</span> {chapters[active]}
      </p>
    </div>
  );
}
