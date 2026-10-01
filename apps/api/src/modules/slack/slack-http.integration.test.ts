import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import {
  SecretCipher,
  SlackIntegrationService,
  SlackOAuthStateStore,
  type SlackClient,
  type SlackInstallation,
} from '@reachinbox/slack';
import type { RequestHandler } from 'express';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../app.js';
import { createSlackRouter } from './slack-router.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required');
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: 1,
});
const prefix = `slack-oauth-test-${randomUUID()}`;
const cipher = new SecretCipher('test-encryption-key-that-is-at-least-32-characters');
const installation: SlackInstallation = {
  accessToken: 'xoxb-sensitive-token',
  teamId: 'T123',
  teamName: 'Test Workspace',
  channelId: 'C123',
  channelName: '#alerts',
  webhookUrl: 'https://hooks.slack.com/services/T/B/sensitive-webhook',
};
const slackClient: SlackClient = {
  exchangeCode: vi.fn(async () => installation),
  revokeToken: vi.fn(async (): Promise<'revoked'> => 'revoked'),
  postWebhook: vi.fn(async () => undefined),
};
const logger = { error: vi.fn() };
let authenticatedUserId: string | undefined;

const authenticate: RequestHandler = (_request, response, next) => {
  if (authenticatedUserId) response.locals.principal = { userId: authenticatedUserId };
  next();
};

function app() {
  const integrations = new SlackIntegrationService({ prisma, cipher, client: slackClient });
  return createApp({
    slackRouter: createSlackRouter({
      authenticate,
      stateStore: new SlackOAuthStateStore(redis, prefix),
      slackClient,
      integrations,
      clientId: 'client-id',
      redirectUri: 'http://localhost:4000/api/v1/integrations/slack/callback',
      frontendUrl: 'http://localhost:5173',
      logger,
    }),
  });
}

async function clearDatabase() {
  await prisma.email.deleteMany();
  await prisma.slackIntegration.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.sender.deleteMany();
  await prisma.user.deleteMany();
}

async function createUser() {
  const token = randomUUID();
  return prisma.user.create({
    data: { googleSub: `slack-${token}`, email: `${token}@test.local`, name: 'Slack User' },
  });
}

async function connectState() {
  const response = await request(app()).get('/api/v1/integrations/slack/connect').expect(302);
  const location = new URL(response.headers.location as string);
  return { location, state: location.searchParams.get('state')! };
}

beforeAll(async () => {
  await Promise.all([prisma.$connect(), redis.ping()]);
});

beforeEach(async () => {
  await clearDatabase();
  authenticatedUserId = undefined;
  vi.mocked(slackClient.exchangeCode).mockResolvedValue(installation);
  vi.mocked(slackClient.revokeToken).mockResolvedValue('revoked');
  vi.mocked(slackClient.postWebhook).mockResolvedValue(undefined);
});

afterEach(async () => {
  const keys = await redis.keys(`${prefix}:*`);
  if (keys.length > 0) await redis.del(...keys);
  vi.clearAllMocks();
});

afterAll(async () => {
  await clearDatabase();
  await Promise.all([prisma.$disconnect(), redis.quit()]);
});

describe('Slack OAuth HTTP integration', () => {
  it('requires authentication for connect and status', async () => {
    await request(app()).get('/api/v1/integrations/slack/connect').expect(401);
    await request(app()).get('/api/v1/integrations/slack/status').expect(401);
  });

  it('creates high-entropy server-side state with TTL and only incoming-webhook scope', async () => {
    authenticatedUserId = (await createUser()).id;
    const { location, state } = await connectState();
    expect(location.origin + location.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(location.searchParams.get('scope')).toBe('incoming-webhook');
    expect(location.searchParams.get('client_id')).toBe('client-id');
    expect(state.length).toBeGreaterThanOrEqual(40);
    expect(await redis.get(`${prefix}:${state}`)).toBe(authenticatedUserId);
    expect(await redis.ttl(`${prefix}:${state}`)).toBeGreaterThan(590);
  });

  it('rejects missing, unknown, and reused OAuth state', async () => {
    const user = await createUser();
    authenticatedUserId = user.id;
    await request(app()).get('/api/v1/integrations/slack/callback').expect(400);
    await request(app())
      .get(`/api/v1/integrations/slack/callback?code=x&state=${'x'.repeat(43)}`)
      .expect(400);
    const expired = await connectState();
    await redis.del(`${prefix}:${expired.state}`);
    await request(app())
      .get(`/api/v1/integrations/slack/callback?code=valid&state=${expired.state}`)
      .expect(400);
    const { state } = await connectState();
    await request(app())
      .get(`/api/v1/integrations/slack/callback?code=valid&state=${state}`)
      .expect(302);
    await request(app())
      .get(`/api/v1/integrations/slack/callback?code=valid&state=${state}`)
      .expect(400);
  });

  it('does not persist an integration when code exchange fails', async () => {
    authenticatedUserId = (await createUser()).id;
    const { state } = await connectState();
    vi.mocked(slackClient.exchangeCode).mockRejectedValueOnce(new Error('provider secret details'));
    const response = await request(app())
      .get(`/api/v1/integrations/slack/callback?code=bad&state=${state}`)
      .expect(502);
    expect(await prisma.slackIntegration.count()).toBe(0);
    expect(JSON.stringify(response.body)).not.toContain('provider secret details');
  });

  it('persists encrypted secrets, exposes safe status, and upserts reconnects', async () => {
    const user = await createUser();
    authenticatedUserId = user.id;
    let { state } = await connectState();
    const callback = await request(app())
      .get(`/api/v1/integrations/slack/callback?code=valid&state=${state}`)
      .expect(302);
    expect(callback.headers.location).toBe('http://localhost:5173/?slack=connected');
    expect(callback.text).not.toContain(installation.accessToken);
    expect(callback.text).not.toContain(installation.webhookUrl);
    const stored = await prisma.slackIntegration.findUniqueOrThrow({ where: { userId: user.id } });
    expect(stored.accessTokenEncrypted).not.toContain(installation.accessToken);
    expect(stored.webhookUrlEncrypted).not.toContain(installation.webhookUrl);
    expect(cipher.decrypt(stored.webhookUrlEncrypted)).toBe(installation.webhookUrl);

    const status = await request(app()).get('/api/v1/integrations/slack/status').expect(200);
    expect(status.body).toMatchObject({
      connected: true,
      teamName: 'Test Workspace',
      channelName: '#alerts',
    });
    expect(JSON.stringify(status.body)).not.toMatch(/token|webhook/i);

    vi.mocked(slackClient.exchangeCode).mockResolvedValueOnce({
      ...installation,
      channelId: 'C999',
      channelName: '#new-alerts',
    });
    ({ state } = await connectState());
    await request(app())
      .get(`/api/v1/integrations/slack/callback?code=reconnect&state=${state}`)
      .expect(302);
    expect(await prisma.slackIntegration.count()).toBe(1);
    expect(
      await prisma.slackIntegration.findUniqueOrThrow({ where: { userId: user.id } }),
    ).toMatchObject({ channelId: 'C999', channelName: '#new-alerts' });
  });

  it('tenant-scopes status and disconnect, revokes, and supports a later reconnect', async () => {
    const owner = await createUser();
    const other = await createUser();
    await new SlackIntegrationService({ prisma, cipher, client: slackClient }).install(
      owner.id,
      installation,
    );
    authenticatedUserId = other.id;
    expect(
      (await request(app()).get('/api/v1/integrations/slack/status').expect(200)).body,
    ).toEqual({ connected: false });
    await request(app()).delete('/api/v1/integrations/slack').expect(200);
    expect(await prisma.slackIntegration.count()).toBe(1);

    authenticatedUserId = owner.id;
    await request(app()).delete('/api/v1/integrations/slack').expect(200);
    expect(slackClient.revokeToken).toHaveBeenCalledWith(installation.accessToken);
    expect(await prisma.slackIntegration.count()).toBe(0);

    const { state } = await connectState();
    await request(app())
      .get(`/api/v1/integrations/slack/callback?code=new&state=${state}`)
      .expect(302);
    expect(await prisma.slackIntegration.count()).toBe(1);
  });

  it('retains the local connection when provider revocation fails', async () => {
    const user = await createUser();
    authenticatedUserId = user.id;
    await new SlackIntegrationService({ prisma, cipher, client: slackClient }).install(
      user.id,
      installation,
    );
    vi.mocked(slackClient.revokeToken).mockRejectedValueOnce(new Error('outage'));
    await request(app()).delete('/api/v1/integrations/slack').expect(502);
    expect(await prisma.slackIntegration.count()).toBe(1);
  });

  it('sends test notifications from stored credentials without accepting a client webhook', async () => {
    const user = await createUser();
    authenticatedUserId = user.id;
    await request(app())
      .post('/api/v1/integrations/slack/test')
      .send({ webhookUrl: 'https://evil.example' })
      .expect(409);
    await new SlackIntegrationService({ prisma, cipher, client: slackClient }).install(
      user.id,
      installation,
    );
    await request(app())
      .post('/api/v1/integrations/slack/test')
      .send({ webhookUrl: 'https://evil.example' })
      .expect(200);
    expect(slackClient.postWebhook).toHaveBeenCalledWith(
      installation.webhookUrl,
      expect.stringContaining('test succeeded'),
    );
  });
});
