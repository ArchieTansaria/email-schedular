import { describe, expect, it, vi } from 'vitest';

import { FetchSlackClient, FetchSlackWebhookClient, SlackProviderError } from './client.js';

describe('Slack HTTP clients', () => {
  it('exchanges through oauth.v2.access using Basic credentials and validates installation data', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ok: true,
        access_token: 'xoxb-secret',
        scope: 'incoming-webhook',
        team: { id: 'T1', name: 'Workspace' },
        incoming_webhook: {
          url: 'https://hooks.slack.com/services/T/B/secret',
          channel_id: 'C1',
          channel: '#alerts',
        },
      }),
    );
    const client = new FetchSlackClient({
      clientId: 'client',
      clientSecret: 'secret',
      redirectUri: 'http://localhost/callback',
      fetch: fetchMock,
    });
    await expect(client.exchangeCode('code')).resolves.toMatchObject({
      teamId: 'T1',
      channelId: 'C1',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://slack.com/api/oauth.v2.access',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: `Basic ${Buffer.from('client:secret').toString('base64')}`,
        }),
      }),
    );
  });

  it('rejects provider errors and invalid webhook hosts', async () => {
    const providerFailure = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: false, error: 'bad_code' }));
    const invalidHost = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        ok: true,
        access_token: 'token',
        scope: 'incoming-webhook',
        team: { id: 'T', name: 'Team' },
        incoming_webhook: {
          url: 'https://evil.example/hook',
          channel_id: 'C',
          channel: '#alerts',
        },
      }),
    );
    await expect(
      new FetchSlackClient({
        clientId: 'c',
        clientSecret: 's',
        redirectUri: 'http://localhost',
        fetch: providerFailure,
      }).exchangeCode('bad'),
    ).rejects.toBeInstanceOf(SlackProviderError);
    await expect(
      new FetchSlackClient({
        clientId: 'c',
        clientSecret: 's',
        redirectUri: 'http://localhost',
        fetch: invalidHost,
      }).exchangeCode('bad'),
    ).rejects.toBeInstanceOf(SlackProviderError);
  });

  it.each([400, 403, 404, 500])('treats webhook HTTP %s as a provider failure', async (status) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('failure', { status }));
    await expect(
      new FetchSlackWebhookClient(fetchMock).postWebhook(
        'https://hooks.slack.com/services/T/B/secret',
        'message',
      ),
    ).rejects.toBeInstanceOf(SlackProviderError);
  });

  it('accepts only the documented webhook success response', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok', { status: 200 }));
    await expect(
      new FetchSlackWebhookClient(fetchMock).postWebhook(
        'https://hooks.slack.com/services/T/B/secret',
        'message',
      ),
    ).resolves.toBeUndefined();
  });
});
