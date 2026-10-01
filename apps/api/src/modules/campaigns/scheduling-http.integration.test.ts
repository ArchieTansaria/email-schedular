import { randomUUID } from 'node:crypto';

import { EmailStatus, PrismaClient } from '@prisma/client';
import type { RequestHandler } from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../app.js';
import { EmailQueueProducer } from '../../queue/email-queue.js';
import { CampaignScheduler } from './campaign-scheduler.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL is required for HTTP integration tests');
const testDatabaseName = new URL(testDatabaseUrl).pathname.split('/').filter(Boolean).at(-1);
if (!testDatabaseName || !/_(?:test|rebuild)$/.test(testDatabaseName)) {
  throw new Error('HTTP integration tests require a database ending in _test or _rebuild');
}

const prisma = new PrismaClient({ datasourceUrl: testDatabaseUrl });
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const fixedNow = new Date('2030-01-01T10:00:00.000Z');
const logger = { error: vi.fn() };
const limits = {
  MIN_SEND_DELAY_MS: 2_000,
  MAX_EMAILS_PER_HOUR_PER_SENDER: 200,
} as const;

let producer: EmailQueueProducer;
let authenticatedUserId: string | undefined;

const testAuthentication: RequestHandler = (_request, response, next) => {
  if (authenticatedUserId) response.locals.principal = { userId: authenticatedUserId };
  next();
};

function createTestApp(queueProducer: Pick<EmailQueueProducer, 'enqueueEmailJobsBulk'>) {
  const scheduler = new CampaignScheduler({
    prisma,
    producer: queueProducer,
    limits,
    logger,
    now: () => fixedNow,
  });
  return createApp({
    campaignScheduler: scheduler,
    authenticationMiddleware: testAuthentication,
    logger,
  });
}

async function clearDatabase(): Promise<void> {
  await prisma.email.deleteMany();
  await prisma.slackIntegration.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.sender.deleteMany();
  await prisma.user.deleteMany();
}

async function createUserAndSender(active = true) {
  const token = randomUUID();
  const user = await prisma.user.create({
    data: {
      googleSub: `google-${token}`,
      email: `${token}@example.test`,
      name: 'HTTP Test User',
    },
  });
  const sender = await prisma.sender.create({
    data: {
      userId: user.id,
      fromName: 'HTTP Test Sender',
      fromEmail: `${token}@sender.test`,
      active,
    },
  });
  return { user, sender };
}

function scheduleRequest(
  app: ReturnType<typeof createTestApp>,
  senderId: string,
  key = 'request-key',
  overrides: { subject?: string; userId?: string } = {},
) {
  const pending = request(app)
    .post('/api/v1/campaigns')
    .set('Idempotency-Key', key)
    .field('subject', overrides.subject ?? 'Campaign subject')
    .field('body', 'Campaign body')
    .field('senderId', senderId)
    .field('startAt', '2030-01-01T10:01:00.000Z')
    .field('delayMs', '2000')
    .field('hourlyLimit', '200');
  if (overrides.userId) pending.field('userId', overrides.userId);
  return pending.attach(
    'file',
    Buffer.from('email\nAlice@Example.com\nalice@example.com\nbob@example.com'),
    {
      filename: 'leads.csv',
      contentType: 'text/csv',
    },
  );
}

beforeEach(async () => {
  await clearDatabase();
  authenticatedUserId = undefined;
  producer = new EmailQueueProducer({
    redisUrl,
    logger,
    prefix: `reachinbox-http-test-${randomUUID()}`,
  });
  await producer.waitUntilReady();
});

afterEach(async () => {
  if (producer) {
    await producer.queue.obliterate({ force: true });
    await producer.close();
  }
  await clearDatabase();
  logger.error.mockClear();
});

afterAll(() => prisma.$disconnect());

describe('POST /api/v1/campaigns', () => {
  it('persists normalized recipients and creates one minimal BullMQ job per Email', async () => {
    const { user, sender } = await createUserAndSender();
    authenticatedUserId = user.id;

    const response = await scheduleRequest(createTestApp(producer), sender.id).expect(202);

    expect(response.body).toMatchObject({
      totalRecipients: 2,
      startAt: '2030-01-01T10:01:00.000Z',
      firstScheduledAt: '2030-01-01T10:01:00.000Z',
      lastScheduledAt: '2030-01-01T10:01:02.000Z',
    });
    const campaign = await prisma.campaign.findUniqueOrThrow({
      where: { id: response.body.campaignId as string },
      include: { emails: { orderBy: { originalScheduledAt: 'asc' } } },
    });
    expect(campaign.totalRecipients).toBe(2);
    expect(campaign.emails.map((email) => email.recipientEmail)).toEqual([
      'alice@example.com',
      'bob@example.com',
    ]);
    for (const email of campaign.emails) {
      expect((await producer.queue.getJob(email.bullJobId))?.data).toEqual({ emailId: email.id });
    }
  });

  it('rejects missing authentication before creating durable or queued work', async () => {
    const { sender } = await createUserAndSender();

    await scheduleRequest(createTestApp(producer), sender.id).expect(401);

    expect(await prisma.campaign.count()).toBe(0);
    expect(await prisma.email.count()).toBe(0);
    expect(await producer.queue.getJobCountByTypes('waiting', 'delayed')).toBe(0);
  });

  it('ignores a caller-controlled userId and uses the authenticated principal', async () => {
    const { user, sender } = await createUserAndSender();
    const attacker = await createUserAndSender();
    authenticatedUserId = user.id;

    const response = await scheduleRequest(createTestApp(producer), sender.id, 'request-key', {
      userId: attacker.user.id,
    }).expect(202);

    await expect(
      prisma.campaign.findFirstOrThrow({ where: { id: response.body.campaignId as string } }),
    ).resolves.toMatchObject({ userId: user.id });
  });

  it('requires an Idempotency-Key without creating durable work', async () => {
    const { user, sender } = await createUserAndSender();
    authenticatedUserId = user.id;

    await request(createTestApp(producer))
      .post('/api/v1/campaigns')
      .field('subject', 'Subject')
      .field('body', 'Body')
      .field('senderId', sender.id)
      .field('startAt', '2030-01-01T10:01:00.000Z')
      .field('delayMs', '2000')
      .field('hourlyLimit', '200')
      .attach('file', Buffer.from('alice@example.com'), 'leads.txt')
      .expect(400);

    await request(createTestApp(producer))
      .post('/api/v1/campaigns')
      .set('Idempotency-Key', '   ')
      .expect(400);

    expect(await prisma.campaign.count()).toBe(0);
  });

  it('returns the same campaign and jobs for an identical idempotent replay', async () => {
    const { user, sender } = await createUserAndSender();
    authenticatedUserId = user.id;
    const app = createTestApp(producer);

    const first = await scheduleRequest(app, sender.id, 'replay-key').expect(202);
    const second = await scheduleRequest(app, sender.id, 'replay-key').expect(202);

    expect(second.body.campaignId).toBe(first.body.campaignId);
    expect(await prisma.campaign.count()).toBe(1);
    expect(await prisma.email.count()).toBe(2);
    expect(await producer.queue.getJobCountByTypes('waiting', 'delayed')).toBe(2);
  });

  it('returns 409 and preserves the original work for conflicting key reuse', async () => {
    const { user, sender } = await createUserAndSender();
    authenticatedUserId = user.id;
    const app = createTestApp(producer);
    const first = await scheduleRequest(app, sender.id, 'conflict-key').expect(202);

    const conflict = await scheduleRequest(app, sender.id, 'conflict-key', {
      subject: 'Different subject',
    }).expect(409);

    expect(conflict.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const original = await prisma.campaign.findUniqueOrThrow({
      where: { id: first.body.campaignId as string },
    });
    expect(original.subject).toBe('Campaign subject');
    expect(await prisma.campaign.count()).toBe(1);
    expect(await prisma.email.count()).toBe(2);
    expect(await producer.queue.getJobCountByTypes('waiting', 'delayed')).toBe(2);
  });

  it.each([
    ['foreign', false],
    ['inactive', true],
  ])('rejects an unavailable %s sender without durable work', async (_kind, inactive) => {
    const authenticated = await createUserAndSender();
    const owner = inactive ? authenticated : await createUserAndSender();
    if (inactive) {
      await prisma.sender.update({ where: { id: owner.sender.id }, data: { active: false } });
    }
    authenticatedUserId = authenticated.user.id;

    await scheduleRequest(createTestApp(producer), owner.sender.id).expect(404);

    expect(await prisma.campaign.count()).toBe(0);
    expect(await prisma.email.count()).toBe(0);
  });

  it('rejects invalid file type and content', async () => {
    const { user, sender } = await createUserAndSender();
    authenticatedUserId = user.id;
    const app = createTestApp(producer);

    await request(app)
      .post('/api/v1/campaigns')
      .set('Idempotency-Key', 'bad-type')
      .attach('file', Buffer.from('{"email":"alice@example.com"}'), {
        filename: 'leads.json',
        contentType: 'application/json',
      })
      .expect(400);

    await request(app)
      .post('/api/v1/campaigns')
      .set('Idempotency-Key', 'bad-content')
      .field('subject', 'Subject')
      .field('body', 'Body')
      .field('senderId', sender.id)
      .field('startAt', '2030-01-01T10:01:00.000Z')
      .field('delayMs', '2000')
      .field('hourlyLimit', '200')
      .attach('file', Buffer.from('not an email'), 'leads.txt')
      .expect(400);

    expect(await prisma.campaign.count()).toBe(0);
  });

  it('rejects a lead file larger than 5 MB', async () => {
    const { user, sender } = await createUserAndSender();
    authenticatedUserId = user.id;

    await request(createTestApp(producer))
      .post('/api/v1/campaigns')
      .set('Idempotency-Key', 'oversized')
      .field('subject', 'Subject')
      .field('body', 'Body')
      .field('senderId', sender.id)
      .field('startAt', '2030-01-01T10:01:00.000Z')
      .field('delayMs', '2000')
      .field('hourlyLimit', '200')
      .attach('file', Buffer.alloc(5 * 1024 * 1024 + 1, 'a'), 'leads.txt')
      .expect(413);

    expect(await prisma.campaign.count()).toBe(0);
  });

  it('keeps committed rows after queue failure and repairs jobs on same-key retry', async () => {
    const { user, sender } = await createUserAndSender();
    authenticatedUserId = user.id;
    const failure = new Error('controlled queue failure');
    const failingProducer = { enqueueEmailJobsBulk: vi.fn().mockRejectedValue(failure) };

    const failed = await scheduleRequest(
      createTestApp(failingProducer),
      sender.id,
      'repair-key',
    ).expect(503);

    expect(failed.body.error).toMatchObject({
      code: 'QUEUE_ENQUEUE_FAILED',
      campaignId: expect.any(String),
    });
    const emails = await prisma.email.findMany();
    expect(emails).toHaveLength(2);
    expect(emails.every((email) => email.status === EmailStatus.SCHEDULED)).toBe(true);
    expect(await producer.queue.getJobCountByTypes('waiting', 'delayed')).toBe(0);

    const repaired = await scheduleRequest(createTestApp(producer), sender.id, 'repair-key').expect(
      202,
    );
    expect(repaired.body.campaignId).toBe(failed.body.error.campaignId);
    expect(await prisma.campaign.count()).toBe(1);
    expect(await prisma.email.count()).toBe(2);
    expect(await producer.queue.getJobCountByTypes('waiting', 'delayed')).toBe(2);
  });

  it('uses PostgreSQL idempotency for concurrent identical HTTP requests', async () => {
    const { user, sender } = await createUserAndSender();
    authenticatedUserId = user.id;
    const app = createTestApp(producer);

    const [first, second] = await Promise.all([
      scheduleRequest(app, sender.id, 'concurrent-key'),
      scheduleRequest(app, sender.id, 'concurrent-key'),
    ]);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.campaignId).toBe(first.body.campaignId);
    expect(await prisma.campaign.count()).toBe(1);
    expect(await prisma.email.count()).toBe(2);
    expect(await producer.queue.getJobCountByTypes('waiting', 'delayed')).toBe(2);
  });
});
