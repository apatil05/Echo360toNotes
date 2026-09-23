import type { CourseRef } from './types';

/** One name for a lecture everywhere: its notes' title, its topic, or the course. */
export function lectureTitle(parts: { noteTitle?: string | null; topic?: string | null; course?: Pick<CourseRef, 'code'> | null }): string {
  return parts.noteTitle || parts.topic || `${parts.course?.code ?? 'Untitled'} lecture`;
}
