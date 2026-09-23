import { useEffect, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router';
import { ArrowLeft, Check, Copy, Download, FileText } from 'lucide-react';
import { Button } from '../../components/Button';
import { ChapterBar } from '../../components/ChapterBar';
import { ChapterDots } from '../../components/ChapterDots';
import { CourseCover } from '../../components/CourseCover';
import { JobStatus } from '../../components/JobStatus';
import { Message } from '../../components/Message';
import { NoteBody } from '../../components/NoteBody';
import { useLecture } from '../../data/library';
import { lectureTitle } from '../../data/lectures';
import { coverStyle } from '../../lib/courseColor';
import { formatDuration, formatLectureDate } from '../../lib/format';
import { ACTIVE_STATUSES } from '../../data/types';
import type { AppOutletContext } from './AppLayout';
import './lecture.css';

export function Lecture() {
  const { id } = useParams();
  const { jobsVersion } = useOutletContext<AppOutletContext>();
  const lecture = useLecture(id);
  const reload = lecture.reload;
  const [copied, setCopied] = useState(false);

  // While a job runs, the notes appear when it finishes.
  useEffect(() => { if (jobsVersion > 0) void reload(); }, [jobsVersion, reload]);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  if (lecture.loading && !lecture.data) return <div className="reader-skeleton" aria-busy="true" aria-label="Loading notes" />;
  if (lecture.error) return <Message tone="bad" title="Couldn’t load this lecture">{lecture.error}</Message>;
  if (!lecture.data) {
    return (
      <div className="reader-missing">
        <h1>Lecture not found</h1>
        <p>It may have been deleted.</p>
        <Button icon={<ArrowLeft aria-hidden="true" />} onClick={() => history.back()}>Back</Button>
      </div>
    );
  }

  const detail = lecture.data;
  const { course, note, job } = detail;
  const title = lectureTitle({ noteTitle: note?.title, topic: detail.topic, course });
  const duration = formatDuration(detail.duration_seconds);
  const running = Boolean(job && ACTIVE_STATUSES.includes(job.status));

  const copy = async () => {
    if (!note) return;
    await navigator.clipboard.writeText(note.body_md);
    setCopied(true);
  };

  const download = () => {
    if (!note) return;
    const name = `${course ? `${course.code} ` : ''}${detail.lecture_date}${note.title ? ` ${note.title}` : ''}`
      .replace(/[^\w\-. ]+/g, '').trim();
    const url = URL.createObjectURL(new Blob([note.body_md], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name || 'lecture-notes'}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <article className="reader" style={course ? coverStyle(course.color) : undefined}>
      <header className="reader-head">
        <div className="reader-meta">
          {course && (
            <Link to={`/courses/${course.id}`} className="reader-course">
              <CourseCover code={course.code} color={course.color} size="sm" decorative />
              <span>
                <strong>{course.code}</strong>
                {course.name && <span className="reader-course-name">{course.name}</span>}
              </span>
            </Link>
          )}
          <p className="reader-facts tabular">
            <span>{formatLectureDate(detail.lecture_date)}</span>
            {duration && <span>{duration}</span>}
            {note && <span>{note.word_count.toLocaleString()} words</span>}
          </p>
        </div>

        <h1>{title}</h1>

        <div className="reader-actions">
          {note && <ChapterDots chapters={note.outline} />}
          <span className="reader-buttons">
            {note && (
              <>
                <Button size="sm" icon={copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />} onClick={copy}>
                  {copied ? 'Copied' : 'Copy markdown'}
                </Button>
                <Button size="sm" icon={<Download aria-hidden="true" />} onClick={download}>Download .md</Button>
              </>
            )}
            {job && (running || !note) && <JobStatus job={job} />}
          </span>
        </div>
      </header>

      {note ? (
        <>
          <ChapterBar chapters={note.outline} />
          <NoteBody markdown={note.body_md} />
        </>
      ) : (
        <div className="reader-pending">
          {running ? (
            <Message tone="info" title="These notes are still being written">
              {job?.status_detail ?? 'This page updates on its own when they’re ready.'}
            </Message>
          ) : job?.status === 'failed' ? (
            <Message tone="bad" title="This lecture couldn’t be processed">
              {job.error_message ?? 'Try again from the job details.'}
            </Message>
          ) : (
            <Message tone="info" title="No notes yet">
              <FileText aria-hidden="true" /> Nothing has been generated for this lecture.
            </Message>
          )}
        </div>
      )}
    </article>
  );
}
