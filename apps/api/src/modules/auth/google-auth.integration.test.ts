import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import {
  SecretCipher,
  SlackIntegrationService,
  SlackOAuthStateStore,
  type SlackClient,
} from '@reachinbox/slack';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../app.js';
import { createSessionPrincipalMiddleware } from '../../middleware/authenticated-principal.js';
import { CampaignScheduler } from '../campaigns/campaign-scheduler.js';
import { EmailQueueProducer } from '../../queue/email-queue.js';
import { createSlackRouter } from '../slack/slack-router.js';
import { createAuthRouter } from './auth-router.js';
import type { GoogleIdentity, GoogleOAuthProvider } from './google-oauth.js';
import { SenderProvisioner } from './sender-provisioner.js';
import {
  createRedisSessionInfrastructure,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  type SessionInfrastructure,
} from './session.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required for auth integration tests');
const databaseName = new URL(databaseUrl).pathname.split('/').filter(Boolean).at(-1);
if (!databaseName || !/_(?:test|rebuild)$/.test(databaseName)) {
  throw new Error('Auth integration tests require a database ending in _test or _rebuild');
}

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const sessionSecret = 'auth-integration-session-secret-that-is-long-enough';
const sessionPrefix = `session:auth-test:${randomUUID()}:`;
const logger = { error: vi.fn() };
const defaultIdentity: GoogleIdentity = {
  sub: 'google-auth-subject',
  email: 'auth-user@example.test',
  name: 'Auth User',
  avatarUrl: 'https://example.test/avatar.png',
};
const configuredSenderEmails = ['sender-one@ethereal.test', 'sender-two@ethereal.test'];

let infrastructure: SessionInfrastructure;
let identity: GoogleIdentity;
const exchangeCode = vi.fn();
const google: GoogleOAuthProvider = {
  generateAuthorizationUrl: ({ state, nonce }) => {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      response_type: 'code',
      scope: 'openid email profile',
      state,
      nonce,
    }).toString();
    return url.toString();
  },
  exchangeCode,
};

async function clearDatabase(): Promise<void> {
  await prisma.email.deleteMany();
  await prisma.slackIntegration.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.sender.deleteMany();
  await prisma.user.deleteMany();
}

function authApp(
  options: {
    sessions?: SessionInfrastructure;
    now?: () => number;
    production?: boolean;
    campaignScheduler?: unknown;
    emailSearch?: unknown;
    slackRouter?: unknown;
  } = {},
) {
  const sessions = options.sessions ?? infrastructure;
  const authenticate = createSessionPrincipalMiddleware(prisma);
  const authRouter = createAuthRouter({
    prisma,
    google,
    authenticate,
    frontendUrl: 'http://localhost:5173/dashboard',
    production: options.production ?? false,
    logger,
    senderProvisioner: new SenderProvisioner({ prisma, senderEmails: configuredSenderEmails }),
    ...(options.now ? { now: options.now } : {}),
  });
  return createApp({
    sessionMiddleware: sessions.middleware,
    authenticationMiddleware: authenticate,
    authRouter,
    logger,
    trustProxy: options.production ?? false,
    ...(options.campaignScheduler ? { campaignScheduler: options.campaignScheduler as never } : {}),
    ...(options.emailSearch ? { emailSearch: options.emailSearch as never } : {}),
    ...(options.slackRouter ? { slackRouter: options.slackRouter as never } : {}),
  });
}

async function beginLogin(agent: ReturnType<typeof request.agent>) {
  const response = await agent.get('/api/v1/auth/google').expect(302);
  const location = new URL(response.headers.location as string);
  return {
    response,
    location,
    state: location.searchParams.get('state')!,
    nonce: location.searchParams.get('nonce')!,
  };
}

async function login(agent: ReturnType<typeof request.agent>) {
  const attempt = await beginLogin(agent);
  const callback = await agent
    .get(`/api/v1/auth/google/callback?code=valid-code&state=${attempt.state}`)
    .expect(302);
  return { ...attempt, callback };
}

function responseCookie(response: request.Response): string {
  const cookies = response.headers['set-cookie'];
  const first = Array.isArray(cookies) ? cookies[0] : cookies;
  if (!first) throw new Error('Expected response cookie');
  return first.split(';', 1)[0]!;
}

beforeAll(async () => {
  infrastructure = await createRedisSessionInfrastructure({
    redisUrl,
    secret: sessionSecret,
    production: false,
    prefix: sessionPrefix,
  });
  await prisma.$connect();
});

beforeEach(async () => {
  await clearDatabase();
  const keys = await infrastructure.client.keys(`${sessionPrefix}*`);
  if (keys.length > 0) await infrastructure.client.del(keys);
  identity = { ...defaultIdentity };
  exchangeCode.mockImplementation(async () => identity);
  logger.error.mockClear();
});

afterAll(async () => {
  await clearDatabase();
  const keys = await infrastructure.client.keys(`${sessionPrefix}*`);
  if (keys.length > 0) await infrastructure.client.del(keys);
  await Promise.all([infrastructure.close(), prisma.$disconnect()]);
});

describe('Google OAuth and Redis sessions', () => {
  it('redirects with minimal scopes and high-entropy state/nonce bound to an opaque HttpOnly session', async () => {
    const attempt = await beginLogin(request.agent(authApp()));
    expect(attempt.location.origin + attempt.location.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(new Set(attempt.location.searchParams.get('scope')?.split(' '))).toEqual(
      new Set(['openid', 'email', 'profile']),
    );
    expect(attempt.location.searchParams.has('access_type')).toBe(false);
    expect(attempt.state.length).toBeGreaterThanOrEqual(40);
    expect(attempt.nonce.length).toBeGreaterThanOrEqual(40);

    const setCookie = attempt.response.headers['set-cookie'] as unknown as string[];
    expect(setCookie[0]).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie[0]).toMatch(/HttpOnly/i);
    expect(setCookie[0]).toMatch(/SameSite=Lax/i);
    expect(setCookie[0]).not.toMatch(/Secure/i);
    expect(setCookie[0]).not.toContain(defaultIdentity.email);
    expect(setCookie[0]).not.toContain(defaultIdentity.sub);

    const keys = await infrastructure.client.keys(`${sessionPrefix}*`);
    expect(keys).toHaveLength(1);
    const stored = await infrastructure.client.get(keys[0]!);
    expect(stored).toContain(attempt.state);
    expect(stored).toContain(attempt.nonce);
    expect(await infrastructure.client.ttl(keys[0]!)).toBeGreaterThan(SESSION_TTL_MS / 1_000 - 30);
  });

  it('rejects missing, mismatched, expired, reused, denied, and failed callbacks safely', async () => {
    const app = authApp();
    await request(app).get('/api/v1/auth/google/callback').expect(400);

    const mismatchAgent = request.agent(app);
    await beginLogin(mismatchAgent);
    await mismatchAgent
      .get(`/api/v1/auth/google/callback?code=x&state=${'x'.repeat(43)}`)
      .expect(400);

    let clock = Date.now();
    const expiryAgent = request.agent(authApp({ now: () => clock }));
    const expired = await beginLogin(expiryAgent);
    clock += 10 * 60 * 1_000 + 1;
    await expiryAgent.get(`/api/v1/auth/google/callback?code=x&state=${expired.state}`).expect(400);

    const deniedAgent = request.agent(app);
    const denied = await beginLogin(deniedAgent);
    const deniedResponse = await deniedAgent
      .get(`/api/v1/auth/google/callback?error=access_denied&state=${denied.state}`)
      .expect(400);
    expect(JSON.stringify(deniedResponse.body)).not.toContain('access_denied');

    const failureAgent = request.agent(app);
    const failed = await beginLogin(failureAgent);
    exchangeCode.mockRejectedValueOnce(new Error('sensitive provider details'));
    const failureResponse = await failureAgent
      .get(`/api/v1/auth/google/callback?code=bad&state=${failed.state}`)
      .expect(502);
    expect(JSON.stringify(failureResponse.body)).not.toContain('sensitive provider details');
    expect(await prisma.user.count()).toBe(0);
    await failureAgent
      .get(`/api/v1/auth/google/callback?code=bad&state=${failed.state}`)
      .expect(400);
  });

  it('upserts by Google sub, updates safe profile fields, and never merges a different sub by email', async () => {
    const firstAgent = request.agent(authApp());
    await login(firstAgent);
    const first = await prisma.user.findUniqueOrThrow({ where: { googleSub: identity.sub } });
    const firstSenders = await prisma.sender.findMany({
      where: { userId: first.id },
      orderBy: { fromEmail: 'asc' },
    });
    expect(firstSenders.map((sender) => sender.fromEmail)).toEqual(configuredSenderEmails);

    const manualSender = await prisma.sender.create({
      data: {
        userId: first.id,
        fromName: 'Existing Manual Sender',
        fromEmail: 'manual-sender@example.test',
      },
    });

    identity = { ...identity, name: 'Updated Name', avatarUrl: null };
    await login(request.agent(authApp()));
    const repeated = await prisma.user.findUniqueOrThrow({ where: { googleSub: identity.sub } });
    expect(repeated).toMatchObject({ id: first.id, name: 'Updated Name', avatarUrl: null });
    expect(await prisma.sender.count({ where: { userId: first.id } })).toBe(3);
    expect(await prisma.sender.findUnique({ where: { id: manualSender.id } })).toMatchObject({
      fromName: 'Existing Manual Sender',
      active: true,
    });

    identity = { ...identity, sub: 'different-google-subject' };
    await login(request.agent(authApp()));
    expect(await prisma.user.count({ where: { email: identity.email } })).toBe(2);
  });

  it('rotates the session after login and exposes only safe /me profile data', async () => {
    const app = authApp();
    const agent = request.agent(app);
    const { response: start, callback } = await login(agent);
    const anonymousCookie = responseCookie(start);
    const authenticatedCookie = responseCookie(callback);
    expect(authenticatedCookie).not.toBe(anonymousCookie);

    await request(app).get('/api/v1/auth/me').set('Cookie', anonymousCookie).expect(401);
    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', authenticatedCookie)
      .expect(200);
    expect(me.body).toEqual({
      id: expect.any(String),
      email: identity.email,
      name: identity.name,
      avatarUrl: identity.avatarUrl,
    });
    expect(JSON.stringify(me.body)).not.toContain(identity.sub);
    expect(JSON.stringify(me.body)).not.toMatch(/session|token/i);
  });

  it('shares sessions across recreated API instances and destroys Redis state on logout', async () => {
    const agent = request.agent(authApp());
    const { callback } = await login(agent);
    const cookie = responseCookie(callback);

    const secondInfrastructure = await createRedisSessionInfrastructure({
      redisUrl,
      secret: sessionSecret,
      production: false,
      prefix: sessionPrefix,
    });
    try {
      await request(authApp({ sessions: secondInfrastructure }))
        .get('/api/v1/auth/me')
        .set('Cookie', cookie)
        .expect(200);
    } finally {
      await secondInfrastructure.close();
    }

    const logout = await request(authApp())
      .post('/api/v1/auth/logout')
      .set('Cookie', cookie)
      .expect(200, { authenticated: false });
    expect(logout.headers['set-cookie']?.[0]).toMatch(/Expires=Thu, 01 Jan 1970/i);
    await request(authApp()).get('/api/v1/auth/me').set('Cookie', cookie).expect(401);
    expect(await infrastructure.client.keys(`${sessionPrefix}*`)).toHaveLength(0);
  });

  it('sets Secure cookies behind the deliberately trusted production proxy', async () => {
    const securePrefix = `${sessionPrefix}secure:`;
    const secureSessions = await createRedisSessionInfrastructure({
      redisUrl,
      secret: sessionSecret,
      production: true,
      prefix: securePrefix,
    });
    try {
      const response = await request(authApp({ sessions: secureSessions, production: true }))
        .get('/api/v1/auth/google')
        .set('X-Forwarded-Proto', 'https')
        .expect(302);
      expect(response.headers['set-cookie']?.[0]).toMatch(/Secure/i);
    } finally {
      const keys = await secureSessions.client.keys(`${securePrefix}*`);
      if (keys.length > 0) await secureSessions.client.del(keys);
      await secureSessions.close();
    }
  });

  it('fails closed with a sanitized response when the Redis session store is unavailable', async () => {
    const isolatedPrefix = `${sessionPrefix}unavailable:`;
    const isolatedSessions = await createRedisSessionInfrastructure({
      redisUrl,
      secret: sessionSecret,
      production: false,
      prefix: isolatedPrefix,
    });
    const app = authApp({ sessions: isolatedSessions });
    const { callback } = await login(request.agent(app));
    const cookie = responseCookie(callback);
    const keys = await isolatedSessions.client.keys(`${isolatedPrefix}*`);
    await isolatedSessions.close();

    const response = await request(app).get('/api/v1/auth/me').set('Cookie', cookie).expect(503);
    expect(response.body).toEqual({
      error: {
        code: 'AUTH_UNAVAILABLE',
        message: 'Authentication is temporarily unavailable',
      },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/redis|connection|closed/i);

    if (keys.length > 0) await infrastructure.client.del(keys);
  });

  it('passes the real session principal into existing Campaign and Search boundaries', async () => {
    const scheduleCampaign = vi.fn(async () => ({
      campaignId: randomUUID(),
      totalRecipients: 1,
      startAt: '2030-01-01T00:00:00.000Z',
      firstScheduledAt: '2030-01-01T00:00:00.000Z',
      lastScheduledAt: '2030-01-01T00:00:00.000Z',
    }));
    const search = vi.fn(async () => ({ items: [], total: 0, page: 1, limit: 20 }));
    const app = authApp({ campaignScheduler: { scheduleCampaign }, emailSearch: { search } });
    const agent = request.agent(app);
    await login(agent);
    const user = await prisma.user.findUniqueOrThrow({ where: { googleSub: identity.sub } });

    await agent
      .post('/api/v1/campaigns')
      .set('Idempotency-Key', 'session-auth-campaign')
      .field('subject', 'Session campaign')
      .field('body', 'Body')
      .field('senderId', randomUUID())
      .field('startAt', '2030-01-01T00:00:00.000Z')
      .field('delayMs', '2000')
      .field('hourlyLimit', '5')
      .attach('file', Buffer.from('lead@example.test'), 'leads.txt')
      .expect(202);
    expect(scheduleCampaign).toHaveBeenCalledWith(
      expect.objectContaining({ userId: user.id, recipients: ['lead@example.test'] }),
    );

    await agent.get('/api/v1/emails/search?q=session').expect(200);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ userId: user.id, q: 'session' }));
  });

  it('enforces real Campaign sender ownership through session identity', async () => {
    const producer = new EmailQueueProducer({
      redisUrl,
      logger,
      prefix: `auth-campaign-test-${randomUUID()}`,
    });
    await producer.waitUntilReady();
    const scheduler = new CampaignScheduler({
      prisma,
      producer,
      limits: { MIN_SEND_DELAY_MS: 2_000, MAX_EMAILS_PER_HOUR_PER_SENDER: 200 },
      logger,
      now: () => new Date('2030-01-01T00:00:00.000Z'),
      searchProjection: {
        indexCampaign: vi.fn().mockResolvedValue({ indexed: 0, failures: [] }),
      },
    });
    try {
      const ownerAgent = request.agent(authApp({ campaignScheduler: scheduler }));
      await login(ownerAgent);
      const owner = await prisma.user.findUniqueOrThrow({ where: { googleSub: identity.sub } });
      const sender = await prisma.sender.create({
        data: {
          userId: owner.id,
          fromName: 'Session Owner',
          fromEmail: 'session-owner@sender.test',
        },
      });

      await ownerAgent
        .post('/api/v1/campaigns')
        .set('Idempotency-Key', 'session-owner-campaign')
        .field('subject', 'Owned sender')
        .field('body', 'Body')
        .field('senderId', sender.id)
        .field('startAt', '2030-01-01T00:01:00.000Z')
        .field('delayMs', '2000')
        .field('hourlyLimit', '5')
        .attach('file', Buffer.from('owner-lead@example.test'), 'leads.txt')
        .expect(202);

      identity = {
        ...identity,
        sub: 'foreign-session-subject',
        email: 'foreign-session@example.test',
      };
      const foreignAgent = request.agent(authApp({ campaignScheduler: scheduler }));
      await login(foreignAgent);
      await foreignAgent
        .post('/api/v1/campaigns')
        .set('Idempotency-Key', 'foreign-sender-campaign')
        .field('subject', 'Foreign sender')
        .field('body', 'Body')
        .field('senderId', sender.id)
        .field('startAt', '2030-01-01T00:01:00.000Z')
        .field('delayMs', '2000')
        .field('hourlyLimit', '5')
        .attach('file', Buffer.from('foreign-lead@example.test'), 'leads.txt')
        .expect(404);
      expect(await prisma.campaign.count()).toBe(1);
    } finally {
      await producer.queue.obliterate({ force: true });
      await producer.close();
    }
  });

  it('uses the real session principal for Slack status, connect, and disconnect', async () => {
    const slackRedis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    const slackPrefix = `slack-session-auth-test-${randomUUID()}`;
    const slackClient: SlackClient = {
      exchangeCode: vi.fn(),
      revokeToken: vi.fn(async (): Promise<'revoked'> => 'revoked'),
      postWebhook: vi.fn(),
    };
    const integrations = new SlackIntegrationService({
      prisma,
      cipher: new SecretCipher('slack-session-test-encryption-key-32-chars'),
      client: slackClient,
    });
    const authenticate = createSessionPrincipalMiddleware(prisma);
    const slackRouter = createSlackRouter({
      authenticate,
      stateStore: new SlackOAuthStateStore(slackRedis, slackPrefix),
      slackClient,
      integrations,
      clientId: 'slack-client-id',
      redirectUri: 'http://localhost:4000/api/v1/integrations/slack/callback',
      frontendUrl: 'http://localhost:5173/dashboard',
      logger,
    });

    try {
      const agent = request.agent(authApp({ slackRouter }));
      await login(agent);
      const user = await prisma.user.findUniqueOrThrow({ where: { googleSub: identity.sub } });
      await agent.get('/api/v1/integrations/slack/status').expect(200, { connected: false });
      const connect = await agent.get('/api/v1/integrations/slack/connect').expect(302);
      const state = new URL(connect.headers.location as string).searchParams.get('state')!;
      expect(await slackRedis.get(`${slackPrefix}:${state}`)).toBe(user.id);

      await integrations.install(user.id, {
        accessToken: 'xoxb-session-test',
        teamId: 'T-session',
        teamName: 'Session Team',
        channelId: 'C-session',
        channelName: '#session-alerts',
        webhookUrl: 'https://hooks.slack.com/services/T/B/session-test',
      });
      const status = await agent.get('/api/v1/integrations/slack/status').expect(200);
      expect(status.body).toMatchObject({
        connected: true,
        teamName: 'Session Team',
        channelName: '#session-alerts',
      });
      await agent.delete('/api/v1/integrations/slack').expect(200, { connected: false });
    } finally {
      const keys = await slackRedis.keys(`${slackPrefix}:*`);
      if (keys.length > 0) await slackRedis.del(...keys);
      await slackRedis.quit();
    }
  });
});
