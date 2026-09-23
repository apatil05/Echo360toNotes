import { useEffect } from 'react';
import { Link, useOutletContext } from 'react-router';
import { Plus, Upload } from 'lucide-react';
import { ButtonLink } from '../../components/Button';
import { CourseCover } from '../../components/CourseCover';
import { AddCourse } from '../../components/AddCourse';
import { EpisodeRow } from '../../components/EpisodeRow';
import { Message } from '../../components/Message';
import { useAuth } from '../../data/authContext';
import { useApiKeys, useRecentEpisodes } from '../../data/library';
import { providerById } from '../../lib/providers';
import { APP_NAME } from '../../lib/brand';
import { firstName, greeting } from '../../lib/format';
import type { AppOutletContext } from './AppLayout';
import './home.css';

export function Home() {
  const { profile } = useAuth();
  const { courses, coursesLoading, reloadCourses, jobsVersion } = useOutletContext<AppOutletContext>();
  const episodes = useRecentEpisodes(15);
  const reloadEpisodes = episodes.reload;
  const keys = useApiKeys();

  // Job changes (live) can add notes or change a lecture's status.
  useEffect(() => { if (jobsVersion > 0) void reloadEpisodes(); }, [jobsVersion, reloadEpisodes]);

  const name = firstName(profile?.display_name);
  const lectureTotal = (courses ?? []).reduce((sum, c) => sum + c.lecture_count, 0);
  const noTranscriber = keys.data && !keys.data.some((k) => providerById(k.provider)?.transcribes);
  const noCourses = !coursesLoading && courses?.length === 0;
  const noEpisodes = !episodes.loading && episodes.data?.length === 0;

  return (
    <div className="home">
      <header className="home-head">
        <div>
          <h1>{greeting()}{name ? `, ${name}` : ''}</h1>
          {courses && courses.length > 0 && (
            <p className="home-sub tabular">
              {courses.length} course{courses.length === 1 ? '' : 's'} · {lectureTotal} lecture{lectureTotal === 1 ? '' : 's'}
            </p>
          )}
        </div>
        <ButtonLink to="/new" variant="primary" size="lg" icon={<Plus aria-hidden="true" />} className="home-new">New lecture</ButtonLink>
      </header>

      {noTranscriber && (
        <Message
          tone="wait"
          title="Lectures without captions can’t be processed yet"
          action={<ButtonLink to="/settings#keys" size="sm">Add a key</ButtonLink>}
        >
          Add a Groq or OpenAI key for speech-to-text. Lectures with captions work already.
        </Message>
      )}

      <section className="home-section" aria-labelledby="shelf-title">
        <div className="home-section-head">
          <h2 id="shelf-title">Your courses</h2>
        </div>
        <div className="shelf" role="list">
          {coursesLoading && !courses
            ? Array.from({ length: 4 }, (_, i) => <span key={i} className="shelf-skeleton" role="listitem" aria-hidden="true" />)
            : courses?.map((c) => (
              <Link key={c.id} to={`/courses/${c.id}`} className="shelf-item" role="listitem">
                <CourseCover code={c.code} color={c.color} decorative />
                <span className="shelf-name" title={c.name ?? c.code}>{c.name ?? c.code}</span>
                <span className="shelf-count tabular">{c.lecture_count} lecture{c.lecture_count === 1 ? '' : 's'}</span>
              </Link>
            ))}
          <div role="listitem" className="shelf-add">
            <AddCourse onAdded={reloadCourses} />
          </div>
        </div>
        {noCourses && (
          <p className="home-hint">Add a course for each class you take. Lectures you send from Echo360 can also create them for you.</p>
        )}
      </section>

      <section className="home-section" aria-labelledby="recent-title">
        <div className="home-section-head">
          <h2 id="recent-title">Lectures</h2>
        </div>

        {episodes.error && (
          <Message tone="bad" title="Couldn’t load your lectures" action={<button type="button" className="btn btn-secondary btn-sm" onClick={() => episodes.reload()}>Try again</button>}>
            {episodes.error}
          </Message>
        )}

        {episodes.loading && !episodes.data ? (
          <ul className="episode-skeletons" aria-busy="true" aria-label="Loading lectures">
            {Array.from({ length: 5 }, (_, i) => <li key={i} className="episode-skeleton" />)}
          </ul>
        ) : noEpisodes ? (
          <div className="home-empty">
            <h3>No lectures yet</h3>
            <p>
              {profile?.onboarding.capture === 'extension'
                ? <>Open a lecture on Echo360, press play for a moment, then choose <strong>Send to {APP_NAME}</strong> in the extension. It appears here while it’s processed.</>
                : <>Upload a lecture recording or transcript, and it appears here while it’s processed.</>}
            </p>
            <ButtonLink to="/new" icon={<Upload aria-hidden="true" />}>Upload a lecture</ButtonLink>
          </div>
        ) : (
          <div className="episodes">
            <ul className="episode-list">
              {episodes.data?.map((e) => <EpisodeRow key={e.id} episode={e} />)}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
