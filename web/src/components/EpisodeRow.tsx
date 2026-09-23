import { Link } from 'react-router';
import { ChapterDots } from './ChapterDots';
import { CourseCover } from './CourseCover';
import { JobStatus } from './JobStatus';
import { coverStyle } from '../lib/courseColor';
import { formatDuration, formatLectureDate } from '../lib/format';
import { ACTIVE_STATUSES, type Episode } from '../data/types';
import { lectureTitle } from '../data/lectures';
import './EpisodeRow.css';

/** One lecture in a list. Rows share the list's columns (subgrid) so they align. */
export function EpisodeRow({ episode }: { episode: Episode }) {
  const { course, note, job } = episode;
  const running = Boolean(job && ACTIVE_STATUSES.includes(job.status));
  const showStatus = Boolean(job && (running || !note));
  const duration = formatDuration(episode.duration_seconds);

  return (
    <li className="ep" style={course ? coverStyle(course.color) : undefined}>
      <Link to={`/lectures/${episode.id}`} className="ep-link">
        {course ? <CourseCover code={course.code} color={course.color} size="sm" decorative /> : <span className="ep-nocover" aria-hidden="true" />}
        <span className="ep-text">
          <span className="ep-title">{lectureTitle({ noteTitle: note?.title, topic: episode.topic, course })}</span>
          <span className="ep-meta">
            {course && <span className="ep-course">{course.code}</span>}
            <span>{formatLectureDate(episode.lecture_date)}</span>
          </span>
        </span>
      </Link>

      <span className="ep-chapters">
        {note?.outline.length ? (
          <ChapterDots chapters={note.outline} />
        ) : running && job?.chunks_total ? (
          <ChapterDots filled={job.chunks_done} total={job.chunks_total} />
        ) : null}
      </span>

      <span className="ep-duration tabular">{duration}</span>

      <span className="ep-state">{showStatus && job ? <JobStatus job={job} /> : null}</span>
    </li>
  );
}
