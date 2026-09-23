import { describeJob } from '../lib/jobStatus';
import './JobStatus.css';

export function JobStatus({ job, compact = false }: { job: Parameters<typeof describeJob>[0]; compact?: boolean }) {
  const { label, tone, Icon } = describeJob(job);
  return (
    <span className={`status status-${tone}${compact ? ' status-compact' : ''}`}>
      <Icon aria-hidden="true" />
      <span className="tabular">{label}</span>
    </span>
  );
}
