export type JobStatus = 'queued' | 'uploading' | 'transcribing' | 'generating' | 'succeeded' | 'failed' | 'canceled';

export const ACTIVE_STATUSES: JobStatus[] = ['queued', 'uploading', 'transcribing', 'generating'];

export interface Onboarding {
  /** Furthest wizard step reached. */
  step_id?: string;
  completed_at?: string;
  /** How the student captures lectures. */
  capture?: 'extension' | 'upload-only';
  transcription?: 'skipped';
}

export interface Profile {
  id: string;
  display_name: string | null;
  timezone: string;
  onboarding: Onboarding;
  default_notes_provider: string | null;
  default_notes_model: string | null;
}

export interface ApiKey {
  id: string;
  provider: string;
  key_hint: string;
  base_url: string | null;
  validated_at: string | null;
  last_used_at: string | null;
}

export type CoverColor = 'violet' | 'coral' | 'teal' | 'blue' | 'pink' | 'amber' | 'green' | 'indigo';

export interface CourseRef {
  id: string;
  code: string;
  color: CoverColor;
}

export interface Course extends CourseRef {
  name: string | null;
  lecture_count: number;
}

export interface Job {
  id: string;
  lecture_id: string;
  source: 'captions' | 'audio' | 'transcript_file' | 'media_file';
  runner: 'browser' | 'lambda';
  status: JobStatus;
  progress: number;
  status_detail: string | null;
  chunks_total: number | null;
  chunks_done: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface NoteSummary {
  id: string;
  title: string;
  outline: string[];
  word_count: number;
}

export interface Note extends NoteSummary {
  body_md: string;
  transcript_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface Episode {
  id: string;
  topic: string | null;
  lecture_date: string;
  duration_seconds: number | null;
  has_captions: boolean | null;
  created_at: string;
  course: (CourseRef & { name: string | null }) | null;
  note: NoteSummary | null;
  job: Job | null;
}

export interface JobWithLecture extends Job {
  lecture: { id: string; topic: string | null; lecture_date: string; course: CourseRef | null } | null;
}

export interface ExtensionLink {
  id: string;
  label: string;
  extension_version: string | null;
  last_seen_at: string;
  created_at: string;
}
