import { z } from 'zod';

const oauthResponseSchema = z.object({
  ok: z.literal(true),
  access_token: z.string().min(1),
  scope: z.string().min(1),
  team: z.object({ id: z.string().min(1), name: z.string().min(1) }),
  incoming_webhook: z.object({
    url: z.url(),
    channel_id: z.string().min(1),
    channel: z.string().min(1),
  }),
});

export interface SlackInstallation {
  accessToken: string;
  teamId: string;
  teamName: string;
  channelId: string;
  channelName: string;
  webhookUrl: string;
}

export interface SlackClient {
  exchangeCode(code: string): Promise<SlackInstallation>;
  revokeToken(accessToken: string): Promise<'revoked' | 'already-revoked'>;
  postWebhook(webhookUrl: string, text: string): Promise<void>;
}

export class SlackProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlackProviderError';
  }
}

export class FetchSlackClient implements SlackClient {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #redirectUri: string;
  readonly #fetch: typeof fetch;

  constructor(options: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    fetch?: typeof fetch;
  }) {
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#redirectUri = options.redirectUri;
    this.#fetch = options.fetch ?? fetch;
  }

  async exchangeCode(code: string): Promise<SlackInstallation> {
    const credentials = Buffer.from(`${this.#clientId}:${this.#clientSecret}`).toString('base64');
    const response = await this.#fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: {
        authorization: `Basic ${credentials}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ code, redirect_uri: this.#redirectUri }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new SlackProviderError(`Slack OAuth HTTP ${response.status}`);
    const payload: unknown = await response.json();
    const parsed = oauthResponseSchema.safeParse(payload);
    if (!parsed.success) {
      const providerError = readProviderError(payload);
      throw new SlackProviderError(
        providerError
          ? `Slack OAuth rejected the code: ${providerError}`
          : 'Slack OAuth returned an invalid installation',
      );
    }
    if (
      !parsed.data.scope
        .split(',')
        .map((scope) => scope.trim())
        .includes('incoming-webhook')
    ) {
      throw new SlackProviderError(
        'Slack OAuth installation is missing the incoming-webhook scope',
      );
    }
    assertWebhookUrl(parsed.data.incoming_webhook.url);
    return {
      accessToken: parsed.data.access_token,
      teamId: parsed.data.team.id,
      teamName: parsed.data.team.name,
      channelId: parsed.data.incoming_webhook.channel_id,
      channelName: parsed.data.incoming_webhook.channel,
      webhookUrl: parsed.data.incoming_webhook.url,
    };
  }

  async revokeToken(accessToken: string): Promise<'revoked' | 'already-revoked'> {
    const response = await this.#fetch('https://slack.com/api/auth.revoke', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new SlackProviderError(`Slack revocation HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (isRecord(payload) && payload.ok === true && payload.revoked === true) return 'revoked';
    const error = readProviderError(payload);
    if (error && ['invalid_auth', 'token_revoked', 'account_inactive'].includes(error))
      return 'already-revoked';
    throw new SlackProviderError(
      error ? `Slack revocation failed: ${error}` : 'Slack revocation returned an invalid response',
    );
  }

  async postWebhook(webhookUrl: string, text: string): Promise<void> {
    return postIncomingWebhook(this.#fetch, webhookUrl, text);
  }
}

export class FetchSlackWebhookClient implements Pick<SlackClient, 'postWebhook'> {
  readonly #fetch: typeof fetch;

  constructor(fetchImplementation: typeof fetch = fetch) {
    this.#fetch = fetchImplementation;
  }

  async postWebhook(webhookUrl: string, text: string): Promise<void> {
    return postIncomingWebhook(this.#fetch, webhookUrl, text);
  }
}

async function postIncomingWebhook(
  fetchImplementation: typeof fetch,
  webhookUrl: string,
  text: string,
): Promise<void> {
  assertWebhookUrl(webhookUrl);
  const response = await fetchImplementation(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new SlackProviderError(`Slack webhook HTTP ${response.status}`);
  const body = await response.text();
  if (body.trim() !== 'ok')
    throw new SlackProviderError('Slack webhook returned an unexpected response');
}

function assertWebhookUrl(value: string): void {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    !['hooks.slack.com', 'hooks.slack-gov.com'].includes(url.hostname)
  ) {
    throw new SlackProviderError('Slack returned an invalid incoming webhook URL');
  }
}

function readProviderError(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.error !== 'string') return undefined;
  return value.error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
