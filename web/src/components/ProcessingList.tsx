import { Link } from 'react-router';
import { AudioLines, CircleAlert, CircleCheck } from 'lucide-react';
import { ChapterDots } from './ChapterDots';
import { CourseCover } from './CourseCover';
import { JobStatus } from './JobStatus';
import { coverStyle } from '../lib/courseColor';
import { formatRelative } from '../lib/format';
import { lectureTitle } from '../data/lectures';
import { ACTIVE_STATUSES, type JobWithLecture } from '../data/types';
import './ProcessingList.css';

const title = (job: JobWithLecture) => lectureTitle({ topic: job.lecture?.topic, course: job.lecture?.course });

/**
 * The side column: what's running now (chapters fill as they're written), then
 * an activity log of what just happened. The library itself lives in the main column.
 */
export function ProcessingList({ jobs, loading }: { jobs: JobWithLecture[] | null; loading: boolean }) {
  const active = (jobs ?? []).filter((j) => ACTIVE_STATUSES.includes(j.status));
  const finishedAt = (j: JobWithLecture) => j.finished_at ?? j.updated_at;
  const events = (jobs ?? [])
    .filter((j) => j.status === 'succeeded' || j.status === 'failed')
    .sort((a, b) => finishedAt(b).localeCompare(finishedAt(a)))
    .slice(0, 5);

  if (loading && !jobs) {
    return <div className="proc-skeleton" aria-busy="true" aria-label="Loading jobs" />;
  }

  return (
    <div className="proc">
      <section aria-labelledby="proc-now">
        <h2 id="proc-now" className="proc-heading">
          Processing
          {active.length > 0 && <span className="proc-count tabular">{active.length}</span>}
        </h2>
        {active.length === 0 ? (
          <p className="proc-empty">
            <AudioLines aria-hidden="true" />
            Nothing processing. Send a lecture from Echo360 or upload one.
          </p>
        ) : (
          <ul className="proc-list">
            {active.map((job) => {
              const course = job.lecture?.course;
              return (
                <li key={job.id} className="proc-item" style={course ? coverStyle(course.color) : undefined}>
                  <Link to={`/jobs/${job.id}`} className="proc-link">
                    {course
                      ? <CourseCover code={course.code} color={course.color} size="sm" decorative />
                      : <span className="proc-chip" aria-hidden="true" />}
                    <span className="proc-text">
                      <span className="proc-title">{title(job)}</span>
                      <JobStatus job={job} compact />
                    </span>
                  </Link>
                  {job.status === 'generating' && job.chunks_total ? (
                    <ChapterDots filled={job.chunks_done} total={job.chunks_total} className="proc-dots" />
                  ) : (
                    <span className="proc-bar" aria-hidden="true">
                      <span style={{ '--fill': Math.max(6, job.status === 'uploading' ? job.progress : Math.min(40, job.progress)) / 100 } as React.CSSProperties} />
                    </span>
                  )}
                  {job.status_detail && <p className="proc-detail">{job.status_detail}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {events.length > 0 && (
        <section aria-labelledby="proc-activity">
          <h2 id="proc-activity" className="proc-heading">Activity</h2>
          <ol className="proc-log">
            {events.map((job) => {
              const ok = job.status === 'succeeded';
              const Icon = ok ? CircleCheck : CircleAlert;
              return (
                <li key={job.id} className={`proc-event ${ok ? 'is-ok' : 'is-bad'}`}>
                  <Icon className="proc-event-icon" aria-hidden="true" />
                  <div className="proc-event-body">
                    <p>
                      <span className="proc-event-verb">{ok ? 'Notes ready' : 'Couldn’t process'}</span>{' '}
                      <Link to={ok ? `/lectures/${job.lecture_id}` : `/jobs/${job.id}`}>{title(job)}</Link>
                    </p>
                    {!ok && job.error_message && <p className="proc-error">{job.error_message}</p>}
                    <time className="proc-time" dateTime={job.finished_at ?? job.updated_at}>
                      {formatRelative(job.finished_at ?? job.updated_at)}
                    </time>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      )}
    </div>
  );
}
