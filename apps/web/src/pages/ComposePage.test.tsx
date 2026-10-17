import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api/client.js';
import type * as ClientModule from '../api/client.js';
import { parseLeadFile } from '../lib/leads.js';
import type * as LeadsModule from '../lib/leads.js';
import { ComposePage } from './ComposePage.js';

vi.mock('../api/client.js', async () => {
  const actual = await vi.importActual<typeof ClientModule>('../api/client.js');
  return { ...actual, api: { ...actual.api, senders: vi.fn(), schedule: vi.fn() } };
});
vi.mock('../lib/leads.js', async () => {
  const actual = await vi.importActual<typeof LeadsModule>('../lib/leads.js');
  return { ...actual, parseLeadFile: vi.fn() };
});

const mockedApi = vi.mocked(api);
const mockedParser = vi.mocked(parseLeadFile);
const sender = {
  id: '00000000-0000-4000-8000-000000000001',
  fromName: 'Sender A',
  fromEmail: 'sender@example.com',
  active: true as const,
};

function renderCompose() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ComposePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function fillValidForm() {
  const file = new File(['alice@example.com\nbob@example.com'], 'leads.csv', { type: 'text/csv' });
  mockedParser.mockResolvedValue({ file, recipients: ['alice@example.com', 'bob@example.com'] });
  fireEvent.change(await screen.findByLabelText('Upload List'), { target: { files: [file] } });
  expect(await screen.findByText(/2 unique valid recipients/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Campaign subject' } });
  const message = await screen.findByRole('textbox', { name: 'Message' });
  await act(async () => {
    message.innerHTML = '<p>Campaign body</p>';
    fireEvent.input(message);
  });
  return file;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedApi.senders.mockResolvedValue({ items: [sender] });
  mockedApi.schedule.mockResolvedValue({
    campaignId: 'campaign',
    totalRecipients: 2,
    startAt: '2030-01-01T00:00:00.000Z',
    firstScheduledAt: '2030-01-01T00:00:00.000Z',
    lastScheduledAt: '2030-01-01T00:00:02.000Z',
  });
});

describe('ComposePage', () => {
  it('submits attachments and lets users remove selected files', async () => {
    renderCompose();
    await fillValidForm();
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('Choose attachments'), { target: { files: [file] } });
    expect(screen.getByRole('button', { name: 'Remove notes.txt' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    await waitFor(() => expect(mockedApi.schedule).toHaveBeenCalledOnce());
    const form = mockedApi.schedule.mock.calls[0]![0];
    expect(form.get('attachments')).toBe(file);
    expect(form.get('bodyHtml')).toContain('<p>Campaign body</p>');
    fireEvent.click(screen.getByRole('button', { name: 'Remove notes.txt' }));
    expect(screen.queryByRole('button', { name: 'Remove notes.txt' })).not.toBeInTheDocument();
  });
  it('shows the no-sender state and disables scheduling', async () => {
    mockedApi.senders.mockResolvedValue({ items: [] });
    renderCompose();
    expect(await screen.findByText(/No configured sender/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Schedule' })).toBeDisabled();
  });

  it('validates required recipient input before submission', async () => {
    renderCompose();
    await screen.findByRole('option', { name: /Sender A/ });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    expect(await screen.findByText('Upload a CSV or TXT recipient list.')).toBeInTheDocument();
    expect(mockedApi.schedule).not.toHaveBeenCalled();
  });

  it('shows parsed chips and submits the original multipart file with converted delay', async () => {
    renderCompose();
    const file = await fillValidForm();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    await waitFor(() => expect(mockedApi.schedule).toHaveBeenCalledOnce());
    const [form, key] = mockedApi.schedule.mock.calls[0]!;
    expect(form.get('file')).toBe(file);
    expect(form.get('delayMs')).toBe('2000');
    expect(form.get('hourlyLimit')).toBe('200');
    expect(form.get('senderId')).toBe(sender.id);
    expect(key).toEqual(expect.any(String));
  });

  it('reuses the request key when an unchanged retryable submission is retried', async () => {
    mockedApi.schedule.mockRejectedValue(
      new ApiError(503, 'QUEUE_ENQUEUE_FAILED', 'Queue unavailable'),
    );
    renderCompose();
    await fillValidForm();
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    expect(await screen.findByText('Queue unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    await waitFor(() => expect(mockedApi.schedule).toHaveBeenCalledTimes(2));
    expect(mockedApi.schedule.mock.calls[1]![1]).toBe(mockedApi.schedule.mock.calls[0]![1]);
  });
});
