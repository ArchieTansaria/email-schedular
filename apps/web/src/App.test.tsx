import type { EmailDetailResponse, EmailListItem } from '@reachinbox/shared/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { api, ApiError } from './api/client.js';
import type * as ClientModule from './api/client.js';

vi.mock('./api/client.js', async () => {
  const actual = await vi.importActual<typeof ClientModule>('./api/client.js');
  return {
    ...actual,
    api: {
      me: vi.fn(),
      logout: vi.fn(),
      senders: vi.fn(),
      emails: vi.fn(),
      email: vi.fn(),
      search: vi.fn(),
      schedule: vi.fn(),
      slackStatus: vi.fn(),
      slackTest: vi.fn(),
      slackDisconnect: vi.fn(),
    },
  };
});

const mockedApi = vi.mocked(api);
const scheduledItem: EmailListItem = {
  id: '00000000-0000-4000-8000-000000000001',
  campaignId: '00000000-0000-4000-8000-000000000002',
  recipientEmail: 'alice@example.com',
  subject: 'Apollo backend hiring',
  bodyPreview: 'A short campaign preview',
  status: 'SCHEDULED',
  scheduledAt: '2030-01-01T10:00:00.000Z',
  sentAt: null,
  failureReason: null,
  sender: {
    id: '00000000-0000-4000-8000-000000000003',
    fromName: 'Sender',
    fromEmail: 'sender@example.com',
  },
};

function renderApp(initialEntry = '/') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.me.mockResolvedValue({
    id: 'user',
    email: 'oliver@example.com',
    name: 'Oliver Brown',
    avatarUrl: null,
  });
  mockedApi.logout.mockResolvedValue({ authenticated: false });
  mockedApi.emails.mockImplementation(async (mode) =>
    mode === 'scheduled'
      ? { items: [scheduledItem], total: 1, nextCursor: null }
      : { items: [], total: 0, nextCursor: null },
  );
  mockedApi.search.mockResolvedValue({ items: [], total: 0, page: 1, limit: 25 });
  mockedApi.slackStatus.mockResolvedValue({ connected: false });
  mockedApi.slackTest.mockResolvedValue({ status: 'success' });
  mockedApi.slackDisconnect.mockResolvedValue({ connected: false });
});

describe('application routes and dashboard', () => {
  it('guards protected routes and exposes the real Google login action', async () => {
    mockedApi.me.mockRejectedValue(new ApiError(401, 'UNAUTHENTICATED', 'Authentication required'));
    renderApp('/');
    expect(await screen.findByRole('link', { name: /login with google/i })).toHaveAttribute(
      'href',
      '/api/v1/auth/google',
    );
  });

  it('renders profile, counts, and scheduled data from the API', async () => {
    renderApp('/');
    expect(await screen.findByText('Oliver Brown')).toBeInTheDocument();
    expect(await screen.findByText('To: alice@example.com')).toBeInTheDocument();
    expect(screen.getByText('Apollo backend hiring')).toBeInTheDocument();
    const callsBeforeRefresh = mockedApi.emails.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh emails' }));
    await waitFor(() =>
      expect(mockedApi.emails.mock.calls.length).toBeGreaterThan(callsBeforeRefresh),
    );
  });

  it('renders a Sent empty state and supports logout', async () => {
    renderApp('/?tab=sent');
    expect(await screen.findByText('No sent emails')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Logout' }));
    await waitFor(() => expect(mockedApi.logout).toHaveBeenCalledOnce());
  });

  it('renders list failures with a retry action', async () => {
    mockedApi.emails.mockImplementation(async (mode) => {
      if (mode === 'scheduled') throw new ApiError(503, 'UNAVAILABLE', 'Email list unavailable');
      return { items: [], total: 0, nextCursor: null };
    });
    renderApp('/');
    expect(await screen.findByText('Email list unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(mockedApi.emails).toHaveBeenCalled());
  });

  it('debounces Elasticsearch search and supplies the active status group', async () => {
    renderApp('/');
    fireEvent.change(await screen.findByPlaceholderText('Search emails'), {
      target: { value: 'backend' },
    });
    await waitFor(
      () =>
        expect(mockedApi.search).toHaveBeenCalledWith(
          expect.objectContaining({ q: 'backend', statuses: ['SCHEDULED', 'PROCESSING'], page: 1 }),
        ),
      { timeout: 1_500 },
    );
    fireEvent.change(screen.getByPlaceholderText('Search emails'), { target: { value: '' } });
    expect(await screen.findByText('To: alice@example.com')).toBeInTheDocument();
  });

  it('renders connected Slack actions and invokes test/disconnect', async () => {
    mockedApi.slackStatus.mockResolvedValue({
      connected: true,
      teamName: 'Workspace',
      channelName: '#alerts',
      connectedAt: '2030-01-01T00:00:00.000Z',
    });
    renderApp('/');
    expect(await screen.findByText('Slack Connected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(mockedApi.slackTest).toHaveBeenCalledOnce());
    await waitFor(() => expect(mockedApi.slackDisconnect).toHaveBeenCalledOnce());
  });

  it('renders a read-only email detail response', async () => {
    const detail: EmailDetailResponse = {
      ...scheduledItem,
      body: 'Full plain text body',
      originalScheduledAt: scheduledItem.scheduledAt,
    };
    mockedApi.email.mockResolvedValue(detail);
    renderApp(`/emails/${scheduledItem.id}`);
    expect(await screen.findByText('Full plain text body')).toBeInTheDocument();
    expect(screen.getByText(/sender@example.com/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });
});
