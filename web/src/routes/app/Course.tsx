import { useEffect } from 'react';
import { useOutletContext, useParams } from 'react-router';
import { Plus, Upload } from 'lucide-react';
import { ButtonLink } from '../../components/Button';
import { CourseCover } from '../../components/CourseCover';
import { EpisodeRow } from '../../components/EpisodeRow';
import { Message } from '../../components/Message';
import { useCourse } from '../../data/library';
import { coverStyle } from '../../lib/courseColor';
import { formatDuration } from '../../lib/format';
import type { AppOutletContext } from './AppLayout';
import './course.css';

export function Course() {
  const { id } = useParams();
  const { jobsVersion } = useOutletContext<AppOutletContext>();
  const course = useCourse(id);
  const reload = course.reload;

  useEffect(() => { if (jobsVersion > 0) void reload(); }, [jobsVersion, reload]);

  if (course.loading && !course.data) return <div className="course-skeleton" aria-busy="true" aria-label="Loading course" />;
  if (course.error) return <Message tone="bad" title="Couldn’t load this course">{course.error}</Message>;
  if (!course.data) return <Message tone="info" title="Course not found">It may have been deleted.</Message>;

  const { code, name, color, episodes } = course.data;
  const ready = episodes.filter((e) => e.note).length;
  const totalSeconds = episodes.reduce((sum, e) => sum + (e.duration_seconds ?? 0), 0);
  const hours = formatDuration(totalSeconds);

  return (
    <div className="course" style={coverStyle(color)}>
      <header className="course-head">
        <CourseCover code={code} color={color} size="lg" decorative />
        <div className="course-titles">
          <h1>{name ?? code}</h1>
          <p className="course-facts tabular">
            <span>{code}</span>
            <span>{episodes.length} lecture{episodes.length === 1 ? '' : 's'}</span>
            <span>{ready} with notes</span>
            {hours && <span>{hours} recorded</span>}
          </p>
          <ButtonLink to="/new" variant="primary" icon={<Plus aria-hidden="true" />}>New lecture</ButtonLink>
        </div>
      </header>

      {episodes.length === 0 ? (
        <div className="course-empty">
          <h2>No lectures in this course yet</h2>
          <p>Send one from Echo360 with the extension, or upload a recording or transcript.</p>
          <ButtonLink to="/new" icon={<Upload aria-hidden="true" />}>Upload a lecture</ButtonLink>
        </div>
      ) : (
        <div className="episodes">
          <ul className="episode-list">
            {episodes.map((e) => <EpisodeRow key={e.id} episode={e} />)}
          </ul>
        </div>
      )}
    </div>
  );
}
