import type { EmailLifecycleStatus } from '@reachinbox/shared/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { api, readableError } from '../api/client.js';
import { useCurrentUser } from '../App.js';
import { EmailList } from '../components/EmailList.js';
import { Icon } from '../components/Icon.js';
import { useDebouncedValue } from '../hooks/useDebouncedValue.js';

type Tab = 'scheduled' | 'sent';

function useEmailPages(mode: Tab, active: boolean) {
  return useInfiniteQuery({
    queryKey: ['emails', mode],
    queryFn: ({ pageParam }) => api.emails(mode, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: active ? 4_000 : false,
  });
}

export function DashboardPage() {
  const user = useCurrentUser().data!;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'sent' ? 'sent' : 'scheduled';
  const [searchText, setSearchText] = useState('');
  const query = useDebouncedValue(searchText.trim(), 300);
  const [notice, setNotice] = useState<string | null>(null);
  const scheduled = useEmailPages('scheduled', tab === 'scheduled' && !query);
  const sent = useEmailPages('sent', tab === 'sent' && !query);
  const activeList = tab === 'scheduled' ? scheduled : sent;
  const statuses: EmailLifecycleStatus[] =
    tab === 'scheduled' ? ['SCHEDULED', 'PROCESSING'] : ['SENT', 'FAILED'];
  const search = useInfiniteQuery({
    queryKey: ['email-search', query, statuses.join(',')],
    queryFn: ({ pageParam }) => api.search({ q: query, statuses, page: pageParam }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) =>
      lastPage.page * lastPage.limit < lastPage.total ? lastPage.page + 1 : undefined,
    enabled: query.length > 0,
    retry: false,
  });
  const slack = useQuery({ queryKey: ['slack', 'status'], queryFn: api.slackStatus, retry: false });

  useEffect(() => {
    const message = params.has('slack')
      ? 'Slack connected successfully.'
      : params.has('scheduled')
        ? `${params.get('scheduled')} recipients scheduled.`
        : null;
    if (!message) return;
    setNotice(message);
    const next = new URLSearchParams(params);
    next.delete('slack');
    next.delete('scheduled');
    setParams(next, { replace: true });
    if (message.startsWith('Slack')) void slack.refetch();
  }, [params, setParams, slack]);

  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: async () => {
      queryClient.clear();
      await navigate('/login', { replace: true });
    },
  });
  const disconnect = useMutation({
    mutationFn: api.slackDisconnect,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['slack'] }),
  });
  const testSlack = useMutation({
    mutationFn: api.slackTest,
    onSuccess: () => setNotice('Slack test message sent.'),
  });

  const ordinaryItems = useMemo(
    () => activeList.data?.pages.flatMap((page) => page.items) ?? [],
    [activeList.data],
  );
  const searchItems = search.data?.pages.flatMap((page) => page.items) ?? [];
  const isSearching = query.length > 0;
  const scheduledTotal = scheduled.data?.pages[0]?.total;
  const sentTotal = sent.data?.pages[0]?.total;

  return (
    <main className="dashboard-shell">
      <aside className="sidebar">
        <Link className="brand" to="/">
          RIB
        </Link>
        <div className="profile-card">
          {user.avatarUrl ? (
            <img alt="" className="h-9 w-9 rounded-full object-cover" src={user.avatarUrl} />
          ) : (
            <div className="avatar-fallback">{user.name.charAt(0)}</div>
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-800">{user.name}</p>
            <p className="truncate text-[11px] text-slate-400">{user.email}</p>
          </div>
          <Icon name="chevron-down" size={13} />
        </div>
        <Link className="compose-button" to="/compose">
          <Icon name="compose" size={14} />
          Compose
        </Link>
        <p className="nav-label">Core</p>
        <button
          className={`nav-item ${tab === 'scheduled' ? 'nav-active' : ''}`}
          onClick={() => setParams({ tab: 'scheduled' })}
          type="button"
        >
          <span>
            <Icon name="clock" size={14} /> Scheduled
          </span>
          <span>{scheduledTotal ?? '—'}</span>
        </button>
        <button
          className={`nav-item ${tab === 'sent' ? 'nav-active' : ''}`}
          onClick={() => setParams({ tab: 'sent' })}
          type="button"
        >
          <span>
            <Icon name="send" size={14} /> Sent
          </span>
          <span>{sentTotal ?? '—'}</span>
        </button>
        <div className="sidebar-footer">
          {slack.data?.connected ? (
            <div className="slack-summary">
              <div className="slack-summary-title">
                <Icon name="slack" size={14} />
                <span>Slack Connected</span>
              </div>
              <p>{slack.data.channelName}</p>
              <div className="slack-actions">
                <button
                  disabled={testSlack.isPending}
                  onClick={() => testSlack.mutate()}
                  type="button"
                >
                  Test
                </button>
                <button
                  disabled={disconnect.isPending}
                  onClick={() => disconnect.mutate()}
                  type="button"
                >
                  Disconnect
                </button>
              </div>
            </div>
          ) : slack.isError ? (
            <p className="integration-note">Slack integration unavailable.</p>
          ) : (
            <button
              className="integration-button"
              onClick={() => window.location.assign('/api/v1/integrations/slack/connect')}
              type="button"
            >
              <Icon name="slack" size={14} />
              Connect Slack
            </button>
          )}
          <button
            className="logout-button"
            disabled={logout.isPending}
            onClick={() => logout.mutate()}
            type="button"
          >
            <Icon name="logout" size={14} />
            {logout.isPending ? 'Logging out…' : 'Logout'}
          </button>
          {testSlack.isError || disconnect.isError || logout.isError ? (
            <p className="integration-error" role="alert">
              {readableError(testSlack.error ?? disconnect.error ?? logout.error)}
            </p>
          ) : null}
        </div>
      </aside>
      <section className="min-w-0 flex-1 bg-white">
        <header className="dashboard-toolbar">
          <label className="search-box">
            <Icon name="search" size={14} />
            <span className="sr-only">Search emails</span>
            <input
              onChange={(event) => setSearchText(event.target.value)}
              placeholder="Search emails"
              value={searchText}
            />
          </label>
          <button
            aria-label="Refresh emails"
            className="icon-button"
            onClick={() => (isSearching ? void search.refetch() : void activeList.refetch())}
            type="button"
          >
            <Icon name="refresh" size={15} />
          </button>
        </header>
        {notice ? (
          <div className="notice" role="status">
            {notice}
            <button aria-label="Dismiss" onClick={() => setNotice(null)} type="button">
              ×
            </button>
          </div>
        ) : null}
        <div className="list-context" aria-live="polite">
          {isSearching ? `${search.data?.pages[0]?.total ?? 0} search results` : null}
        </div>
        <EmailList
          error={
            (isSearching ? search.error : activeList.error)
              ? readableError(isSearching ? search.error : activeList.error)
              : null
          }
          hasMore={isSearching ? search.hasNextPage : activeList.hasNextPage}
          items={isSearching ? searchItems : ordinaryItems}
          loading={isSearching ? search.isPending : activeList.isPending}
          loadingMore={isSearching ? search.isFetchingNextPage : activeList.isFetchingNextPage}
          mode={tab}
          onLoadMore={() =>
            isSearching ? void search.fetchNextPage() : void activeList.fetchNextPage()
          }
          onRetry={() => (isSearching ? void search.refetch() : void activeList.refetch())}
        />
      </section>
    </main>
  );
}
