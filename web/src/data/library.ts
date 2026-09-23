import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import type { ApiKey, Course, CourseRef, Episode, ExtensionLink, Job, JobWithLecture, Note } from './types';

interface Loadable<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
}

function useQuery<T>(load: () => Promise<T>, deps: unknown[]): Loadable<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  useLayoutEffect(() => { loadRef.current = load; });

  const reload = useCallback(async () => {
    try {
      const next = await loadRef.current();
      setData(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // `deps` is the caller's dependency list for `load`.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void reload(); }, deps);
  return { data, error, loading, reload };
}

const must = <T,>({ data, error }: { data: T | null; error: { message: string } | null }): T => {
  if (error) throw new Error(error.message);
  return data as T;
};

export function useCourses(): Loadable<Course[]> {
  return useQuery(async () => {
    const rows = must(await supabase
      .from('courses')
      .select('id, code, name, color, lectures(count)')
      .order('code'));
    return (rows as (Omit<Course, 'lecture_count'> & { lectures: { count: number }[] })[]).map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      color: r.color,
      lecture_count: r.lectures?.[0]?.count ?? 0,
    }));
  }, []);
}

const EPISODE_SELECT = `
  id, topic, lecture_date, duration_seconds, has_captions, created_at,
  course:courses(id, code, name, color),
  notes(id, title, outline, word_count, created_at),
  jobs(id, lecture_id, source, runner, status, progress, status_detail, chunks_total, chunks_done,
       error_code, error_message, created_at, updated_at, finished_at)
`;

type EpisodeRow = Omit<Episode, 'note' | 'job'> & {
  notes: (Episode['note'] & { created_at: string })[];
  jobs: Job[];
};

const latest = <T extends { created_at: string }>(rows: T[] | null | undefined): T | null =>
  rows?.length ? [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] : null;

function toEpisode(row: EpisodeRow): Episode {
  const note = latest(row.notes);
  return {
    id: row.id,
    topic: row.topic,
    lecture_date: row.lecture_date,
    duration_seconds: row.duration_seconds,
    has_captions: row.has_captions,
    created_at: row.created_at,
    course: row.course,
    note: note && { id: note.id, title: note.title, outline: note.outline ?? [], word_count: note.word_count },
    job: latest(row.jobs),
  };
}

export function useRecentEpisodes(limit = 12): Loadable<Episode[]> {
  return useQuery(async () => {
    const rows = must(await supabase
      .from('lectures')
      .select(EPISODE_SELECT)
      .order('lecture_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(limit));
    return (rows as unknown as EpisodeRow[]).map(toEpisode);
  }, [limit]);
}

const JOB_COLUMNS = `id, lecture_id, source, runner, status, progress, status_detail, chunks_total, chunks_done,
  error_code, error_message, created_at, updated_at, finished_at,
  lecture:lectures(id, topic, lecture_date, course:courses(id, code, color))`;

/** Recent jobs, kept live through Supabase Realtime (RLS limits events to the student's own rows). */
export function useLiveJobs(limit = 12, onChange?: () => void): Loadable<JobWithLecture[]> {
  const q = useQuery(async () => {
    const rows = must(await supabase.from('jobs').select(JOB_COLUMNS).order('created_at', { ascending: false }).limit(limit));
    return rows as unknown as JobWithLecture[];
  }, [limit]);

  const { reload } = q;
  const onChangeRef = useRef(onChange);
  useLayoutEffect(() => { onChangeRef.current = onChange; });

  useEffect(() => {
    const channel = supabase
      .channel('jobs-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'jobs' }, () => {
        void reload();
        onChangeRef.current?.();
      })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [reload]);

  return q;
}

const NOTE_COLUMNS = 'id, title, body_md, outline, word_count, transcript_path, created_at, updated_at';

export interface LectureDetail extends Omit<Episode, 'note'> {
  note: Note | null;
}

/** One lecture with its full notes, for the reader. */
export function useLecture(id: string | undefined): Loadable<LectureDetail | null> {
  return useQuery(async () => {
    if (!id) return null;
    const row = must(await supabase
      .from('lectures')
      .select(`id, topic, lecture_date, duration_seconds, has_captions, created_at,
               course:courses(id, code, name, color),
               notes(${NOTE_COLUMNS}),
               jobs(id, lecture_id, source, runner, status, progress, status_detail, chunks_total, chunks_done,
                    error_code, error_message, created_at, updated_at, finished_at)`)
      .eq('id', id)
      .maybeSingle());
    if (!row) return null;
    const r = row as unknown as Omit<LectureDetail, 'note' | 'job'> & { notes: Note[]; jobs: Job[] };
    return { ...r, note: latest(r.notes), job: latest(r.jobs) };
  }, [id]);
}

export interface CourseDetail extends CourseRef {
  name: string | null;
  episodes: Episode[];
}

/** One course and its lectures. */
export function useCourse(id: string | undefined): Loadable<CourseDetail | null> {
  return useQuery(async () => {
    if (!id) return null;
    const course = must(await supabase.from('courses').select('id, code, name, color').eq('id', id).maybeSingle());
    if (!course) return null;
    const rows = must(await supabase
      .from('lectures')
      .select(EPISODE_SELECT)
      .eq('course_id', id)
      .order('lecture_date', { ascending: false })
      .order('created_at', { ascending: false }));
    return { ...(course as CourseRef & { name: string | null }), episodes: (rows as unknown as EpisodeRow[]).map(toEpisode) };
  }, [id]);
}

export function useApiKeys(): Loadable<ApiKey[]> {
  return useQuery(async () => {
    const rows = must(await supabase
      .from('api_keys')
      .select('id, provider, key_hint, base_url, validated_at, last_used_at')
      .order('created_at'));
    return rows as ApiKey[];
  }, []);
}

export function useExtensionLinks(): Loadable<ExtensionLink[]> {
  const q = useQuery(async () => {
    const rows = must(await supabase
      .from('extension_links')
      .select('id, label, extension_version, last_seen_at, created_at')
      .order('last_seen_at', { ascending: false }));
    return rows as ExtensionLink[];
  }, []);

  const { reload } = q;
  useEffect(() => {
    const channel = supabase
      .channel('extension-links')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'extension_links' }, () => { void reload(); })
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [reload]);

  return q;
}
