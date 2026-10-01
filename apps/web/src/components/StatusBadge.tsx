import type { EmailLifecycleStatus } from '@reachinbox/shared/contracts';

const labels: Record<EmailLifecycleStatus, string> = {
  SCHEDULED: 'Scheduled',
  PROCESSING: 'Processing',
  SENT: 'Sent',
  FAILED: 'Failed',
};

export function StatusBadge({ status }: { status: EmailLifecycleStatus }) {
  return <span className={`status-badge status-${status.toLowerCase()}`}>{labels[status]}</span>;
}
