import type {
  CurrentUserResponse,
  EmailDetailResponse,
  EmailLifecycleStatus,
  EmailListResponse,
  EmailSearchResponse,
  ScheduleCampaignResponse,
  SenderListResponse,
  SlackStatusResponse,
} from '@reachinbox/shared/contracts';

interface ErrorResponse {
  error?: { code?: string; message?: string; issues?: unknown };
  status?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: unknown;

  constructor(status: number, code: string, message: string, issues?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, credentials: 'include' });
  const body = (await response.json().catch(() => ({}))) as ErrorResponse | T;
  if (!response.ok) {
    const error = body as ErrorResponse;
    throw new ApiError(
      response.status,
      error.error?.code ?? error.status ?? 'REQUEST_FAILED',
      error.error?.message ?? `Request failed (${response.status})`,
      error.error?.issues,
    );
  }
  return body as T;
}

export const api = {
  me: () => request<CurrentUserResponse>('/api/v1/auth/me'),
  logout: () => request<{ authenticated: false }>('/api/v1/auth/logout', { method: 'POST' }),
  senders: () => request<SenderListResponse>('/api/v1/senders'),
  emails: (mode: 'scheduled' | 'sent', cursor?: string) => {
    const params = new URLSearchParams({ limit: '25' });
    if (cursor) params.set('cursor', cursor);
    return request<EmailListResponse>(`/api/v1/emails/${mode}?${params}`);
  },
  email: (id: string) => request<EmailDetailResponse>(`/api/v1/emails/${id}`),
  search: (input: {
    q: string;
    statuses: readonly EmailLifecycleStatus[];
    page: number;
    limit?: number;
  }) => {
    const params = new URLSearchParams({
      q: input.q,
      page: String(input.page),
      limit: String(input.limit ?? 25),
    });
    for (const status of input.statuses) params.append('status', status);
    return request<EmailSearchResponse>(`/api/v1/emails/search?${params}`);
  },
  schedule: (form: FormData, idempotencyKey: string) =>
    request<ScheduleCampaignResponse>('/api/v1/campaigns', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: form,
    }),
  slackStatus: () => request<SlackStatusResponse>('/api/v1/integrations/slack/status'),
  slackTest: () =>
    request<{ status: 'success' | 'not_connected' | 'provider_failure' }>(
      '/api/v1/integrations/slack/test',
      { method: 'POST' },
    ),
  slackDisconnect: () =>
    request<{ connected: false }>('/api/v1/integrations/slack', { method: 'DELETE' }),
};

export function readableError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Please try again.';
}
