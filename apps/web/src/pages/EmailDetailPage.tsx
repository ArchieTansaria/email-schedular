import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, readableError } from '../api/client.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { Icon } from '../components/Icon.js';
import { formatDateTime } from '../lib/time.js';

export function EmailDetailPage() {
  const { id = '' } = useParams();
  const email = useQuery({
    queryKey: ['email', id],
    queryFn: () => api.email(id),
    enabled: Boolean(id),
    retry: false,
  });
  if (email.isPending)
    return (
      <main className="detail-page">
        <p>Loading email…</p>
      </main>
    );
  if (email.isError)
    return (
      <main className="detail-page">
        <Link to="/">
          <Icon name="arrow-left" size={18} /> Back
        </Link>
        <div className="empty-state" role="alert">
          {readableError(email.error)}
          <button
            className="button-secondary mt-3"
            onClick={() => void email.refetch()}
            type="button"
          >
            Try again
          </button>
        </div>
      </main>
    );
  const item = email.data;
  return (
    <main className="detail-page">
      <header className="detail-header">
        <Link aria-label="Back to dashboard" to="/">
          <Icon name="arrow-left" size={19} />
        </Link>
        <h1>{item.subject}</h1>
        <div className="detail-status">
          <StatusBadge status={item.status} />
        </div>
      </header>
      <article className="detail-content">
        <div className="detail-sender">
          <div className="avatar-fallback">{item.sender.fromName.charAt(0)}</div>
          <div className="min-w-0">
            <p className="sender-name">
              {item.sender.fromName} <span>&lt;{item.sender.fromEmail}&gt;</span>
            </p>
            <p className="recipient-meta">to {item.recipientEmail}</p>
          </div>
          <time>{formatDateTime(item.sentAt ?? item.scheduledAt)}</time>
        </div>
        <div className="email-body">{item.body}</div>
        {item.failureReason ? (
          <div className="mt-6 rounded-lg bg-red-50 p-4 text-sm text-red-700">
            <strong>Delivery failed:</strong> {item.failureReason}
          </div>
        ) : null}
      </article>
    </main>
  );
}
