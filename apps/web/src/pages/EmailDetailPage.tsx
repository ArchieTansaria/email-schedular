import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, readableError } from '../api/client.js';
import { StatusBadge } from '../components/StatusBadge.js';
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
        <Link to="/">← Back</Link>
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
      <header className="flex items-center gap-3 border-b border-slate-100 pb-5">
        <Link aria-label="Back to dashboard" to="/">
          ←
        </Link>
        <h1 className="text-xl font-semibold text-slate-900">{item.subject}</h1>
        <div className="ml-auto">
          <StatusBadge status={item.status} />
        </div>
      </header>
      <article className="mx-auto mt-8 max-w-4xl">
        <div className="flex items-start gap-4">
          <div className="avatar-fallback h-11 w-11">{item.sender.fromName.charAt(0)}</div>
          <div>
            <p className="font-semibold text-slate-900">
              {item.sender.fromName}{' '}
              <span className="font-normal text-slate-400">&lt;{item.sender.fromEmail}&gt;</span>
            </p>
            <p className="mt-1 text-xs text-slate-500">to {item.recipientEmail}</p>
          </div>
          <time className="ml-auto text-xs text-slate-400">
            {formatDateTime(item.sentAt ?? item.scheduledAt)}
          </time>
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
