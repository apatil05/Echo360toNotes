import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { AudioLines, House, LogOut, Plus, Settings, X } from 'lucide-react';
import { Button } from '../../components/Button';
import { CourseCover } from '../../components/CourseCover';
import { ProcessingList } from '../../components/ProcessingList';
import { Wordmark } from '../../components/Wordmark';
import { useAuth } from '../../data/authContext';
import { useCourses, useLiveJobs } from '../../data/library';
import { ACTIVE_STATUSES, type Course, type JobWithLecture } from '../../data/types';
import './app.css';

export interface AppOutletContext {
  courses: Course[] | null;
  coursesLoading: boolean;
  reloadCourses: () => Promise<void>;
  /** Bumps whenever a job changes, so pages can refresh what they show. */
  jobsVersion: number;
  jobs: JobWithLecture[] | null;
}

export function AppLayout() {
  const { profile, session, signOut } = useAuth();
  const courses = useCourses();
  const reloadCourses = courses.reload;
  const [jobsVersion, setJobsVersion] = useState(0);
  const jobs = useLiveJobs(12, () => setJobsVersion((v) => v + 1));
  const activeCount = (jobs.data ?? []).filter((j) => ACTIVE_STATUSES.includes(j.status)).length;
  const drawer = useRef<HTMLDialogElement>(null);
  const location = useLocation();

  // A course can appear from a finished job; keep the sidebar current.
  useEffect(() => { if (jobsVersion > 0) void reloadCourses(); }, [jobsVersion, reloadCourses]);
  useEffect(() => { drawer.current?.close(); }, [location.pathname]);

  const context: AppOutletContext = {
    courses: courses.data,
    coursesLoading: courses.loading,
    reloadCourses: courses.reload,
    jobsVersion,
    jobs: jobs.data,
  };

  const who = profile?.display_name || session?.user.email || 'Your account';

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Main">
        <Link to="/" className="sidebar-brand"><Wordmark /></Link>
        <nav className="sidebar-nav">
          <NavLink to="/" end className="sidebar-link"><House aria-hidden="true" />Home</NavLink>
          <NavLink to="/new" className="sidebar-link"><Plus aria-hidden="true" />New lecture</NavLink>
        </nav>

        <nav className="sidebar-courses" aria-labelledby="sidebar-courses-title">
          <h2 id="sidebar-courses-title" className="sidebar-title">Courses</h2>
          {courses.data?.length ? (
            <ul>
              {courses.data.map((c) => (
                <li key={c.id}>
                  <NavLink to={`/courses/${c.id}`} className="sidebar-course">
                    <CourseCover code={c.code} color={c.color} size="xs" decorative />
                    <span className="sidebar-course-code">{c.code}</span>
                    {c.name && <span className="sidebar-course-name">{c.name}</span>}
                  </NavLink>
                </li>
              ))}
            </ul>
          ) : (
            <p className="sidebar-empty">{courses.loading ? 'Loading…' : 'Courses you add appear here.'}</p>
          )}
        </nav>

        <div className="sidebar-foot">
          <NavLink to="/settings" className="sidebar-link"><Settings aria-hidden="true" />Settings</NavLink>
          <div className="sidebar-account">
            <span className="sidebar-account-name" title={session?.user.email}>{who}</span>
            <Button variant="ghost" size="sm" onClick={signOut} icon={<LogOut aria-hidden="true" />} aria-label="Sign out" />
          </div>
        </div>
      </aside>

      <div className="shell-main">
        <header className="topbar">
          <Link to="/" className="topbar-brand"><Wordmark /></Link>
          <button type="button" className="topbar-activity" onClick={() => drawer.current?.showModal()}>
            <AudioLines aria-hidden="true" />
            {activeCount > 0 ? <span className="tabular">{activeCount} processing</span> : <span>Activity</span>}
          </button>
        </header>
        <main className="shell-content" id="main">
          <Outlet context={context} />
        </main>
      </div>

      <aside className="rail" aria-label="Processing">
        <ProcessingList jobs={jobs.data} loading={jobs.loading} />
      </aside>

      <dialog ref={drawer} className="drawer" aria-label="Processing" onClick={(e) => { if (e.target === e.currentTarget) drawer.current?.close(); }}>
        <div className="drawer-body">
          <Button variant="ghost" size="sm" className="drawer-close" icon={<X aria-hidden="true" />} onClick={() => drawer.current?.close()} aria-label="Close" />
          <ProcessingList jobs={jobs.data} loading={jobs.loading} />
        </div>
      </dialog>

      <nav className="tabbar" aria-label="Main">
        <NavLink to="/" end className="tab"><House aria-hidden="true" /><span>Home</span></NavLink>
        <NavLink to="/new" className="tab"><Plus aria-hidden="true" /><span>New</span></NavLink>
        <button type="button" className="tab" onClick={() => drawer.current?.showModal()}>
          <AudioLines aria-hidden="true" />
          <span>Activity</span>
          {activeCount > 0 && <span className="tab-badge tabular">{activeCount}</span>}
        </button>
        <NavLink to="/settings" className="tab"><Settings aria-hidden="true" /><span>Settings</span></NavLink>
      </nav>
    </div>
  );
}
