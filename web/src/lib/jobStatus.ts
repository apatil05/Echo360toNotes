import { AudioLines, Ban, CircleAlert, CircleCheck, Clock3, Hourglass, PenLine, UploadCloud } from 'lucide-react';
import type { Job } from '../data/types';

export type StatusTone = 'neutral' | 'active' | 'ok' | 'wait' | 'bad';

export interface StatusView {
  label: string;
  tone: StatusTone;
  Icon: typeof Clock3;
}

const waitingForProvider = (job: Pick<Job, 'status_detail'>) => /rate limit|waiting to retry|continuing shortly|retrying/i.test(job.status_detail ?? '');

export function describeJob(job: Pick<Job, 'status' | 'progress' | 'chunks_done' | 'chunks_total' | 'status_detail'>): StatusView {
  switch (job.status) {
    case 'queued':
      return { label: 'Queued', tone: 'neutral', Icon: Clock3 };
    case 'uploading':
      return { label: job.progress > 0 ? `Uploading ${job.progress}%` : 'Uploading', tone: 'active', Icon: UploadCloud };
    case 'transcribing':
      return waitingForProvider(job)
        ? { label: 'Waiting for provider', tone: 'wait', Icon: Hourglass }
        : { label: 'Transcribing', tone: 'active', Icon: AudioLines };
    case 'generating':
      if (waitingForProvider(job)) return { label: 'Waiting for provider', tone: 'wait', Icon: Hourglass };
      return {
        label: job.chunks_total ? `Writing ${job.chunks_done}/${job.chunks_total}` : 'Writing notes',
        tone: 'active',
        Icon: PenLine,
      };
    case 'succeeded':
      return { label: 'Ready', tone: 'ok', Icon: CircleCheck };
    case 'failed':
      return { label: 'Failed', tone: 'bad', Icon: CircleAlert };
    case 'canceled':
      return { label: 'Canceled', tone: 'neutral', Icon: Ban };
  }
}
