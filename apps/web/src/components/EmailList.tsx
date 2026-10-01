import type {
  EmailLifecycleStatus,
  EmailListItem,
  EmailSearchItem,
} from '@reachinbox/shared/contracts';
import { Link } from 'react-router-dom';
import { formatDateTime } from '../lib/time.js';
import { StatusBadge } from './StatusBadge.js';

export type DisplayEmail = EmailListItem | EmailSearchItem;
const idOf = (item: DisplayEmail) => ('id' in item ? item.id : item.emailId);

export function EmailList({
  items,
  mode,
  loading,
  error,
  onRetry,
  hasMore,
  loadingMore,
  onLoadMore,
}: {
  items: DisplayEmail[];
  mode: 'scheduled' | 'sent';
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  if (loading)
    return (
      <div aria-label="Loading emails" className="space-y-1 p-4">
        {[1, 2, 3].map((key) => (
          <div className="h-14 animate-pulse rounded bg-slate-100" key={key} />
        ))}
      </div>
    );
  if (error)
    return (
      <div className="empty-state" role="alert">
        <p>{error}</p>
        <button className="button-secondary mt-3" onClick={onRetry} type="button">
          Try again
        </button>
      </div>
    );
  if (items.length === 0)
    return (
      <div className="empty-state">
        <h2 className="font-semibold text-slate-800">No {mode} emails</h2>
        <p className="mt-1">
          {mode === 'scheduled'
            ? 'Schedule a campaign to see it here.'
            : 'Completed deliveries will appear here.'}
        </p>
      </div>
    );

  return (
    <div>
      <div className="divide-y divide-slate-100">
        {items.map((item) => {
          const id = idOf(item);
          const bodyPreview = 'bodyPreview' in item ? item.bodyPreview : item.body;
          const time = mode === 'sent' ? item.sentAt : item.scheduledAt;
          return (
            <Link className="email-row" key={id} to={`/emails/${id}`}>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-800">
                  To: {item.recipientEmail}
                </p>
                <p className="mt-1 truncate text-xs text-slate-400">{bodyPreview}</p>
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-800">{item.subject}</p>
                {item.status === 'FAILED' && item.failureReason ? (
                  <p className="mt-1 truncate text-xs text-red-500">{item.failureReason}</p>
                ) : null}
              </div>
              <time className="text-xs text-slate-500">{formatDateTime(time)}</time>
              <StatusBadge status={item.status as EmailLifecycleStatus} />
            </Link>
          );
        })}
      </div>
      {hasMore ? (
        <div className="flex justify-center border-t border-slate-100 p-4">
          <button
            className="button-secondary"
            disabled={loadingMore}
            onClick={onLoadMore}
            type="button"
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
