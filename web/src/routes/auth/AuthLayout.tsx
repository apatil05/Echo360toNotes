import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Wordmark } from '../../components/Wordmark';
import { ChapterDots } from '../../components/ChapterDots';
import { CourseCover } from '../../components/CourseCover';
import { coverStyle } from '../../lib/courseColor';
import './auth.css';

// Illustrative content for the preview panel only (labelled as an example on screen).
const EXAMPLE_COURSES = [
  { code: 'CS 220', color: 'violet' },
  { code: 'BIO 151', color: 'teal' },
  { code: 'PSY 100', color: 'amber' },
] as const;

const EXAMPLE_EPISODES = [
  { course: EXAMPLE_COURSES[0], title: 'Merge sort and divide and conquer', meta: 'Sep 16 · 1:14:52', chapters: ['Big picture', 'Splitting the list', 'Merging', 'Running time', 'Stability', 'Key terms'] },
  { course: EXAMPLE_COURSES[1], title: 'Cell membranes and transport', meta: 'Sep 15 · 49:10', chapters: ['Big picture', 'Lipid bilayer', 'Passive transport', 'Active transport', 'Key terms'] },
];

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <main className="auth-main">
        <Link to="/sign-in" className="auth-brand" aria-label="Home">
          <Wordmark />
        </Link>
        <div className="auth-form">{children}</div>
      </main>

      <aside className="auth-preview" aria-label="Example of your library">
        <div className="auth-preview-inner">
          <p className="auth-preview-lede">
            Every lecture becomes study notes, sorted by course and broken into chapters.
          </p>
          <div className="auth-shelf" aria-hidden="true">
            {EXAMPLE_COURSES.map((c) => (
              <CourseCover key={c.code} code={c.code} color={c.color} size="lg" decorative />
            ))}
          </div>
          <ul className="auth-episodes">
            {EXAMPLE_EPISODES.map((e) => (
              <li key={e.title} className="auth-episode" style={coverStyle(e.course.color)}>
                <CourseCover code={e.course.code} color={e.course.color} size="sm" decorative />
                <span className="auth-episode-text">
                  <span className="auth-episode-title">{e.title}</span>
                  <span className="auth-episode-meta tabular">{e.course.code} · {e.meta}</span>
                </span>
                <ChapterDots chapters={e.chapters} />
              </li>
            ))}
          </ul>
          <p className="auth-preview-note">Example library</p>
        </div>
      </aside>
    </div>
  );
}
