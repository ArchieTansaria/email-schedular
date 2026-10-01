import { randomUUID } from 'node:crypto';

import { EmailStatus, PrismaClient } from '@prisma/client';
import {
  EMAIL_QUEUE_NAME,
  SEND_EMAIL_JOB_NAME,
  makeEmailJobId,
  type SendEmailJobData,
} from '@reachinbox/shared/queue';
import { Queue, type Worker } from 'bullmq';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEmailWorker } from '../email-worker.js';
import {
  createLimiterRedisClient,
  RedisSendPermitGate,
  type SendPermitGate,
} from '../rate-limit/send-permit.js';
import { makeSmtpMessageId } from '../smtp/message.js';
import type { DeliveryInput, EmailSender } from '../smtp/types.js';
import { EmailProcessor } from './email-processor.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL is required for throttling tests');
const testDatabaseName = new URL(testDatabaseUrl).pathname.split('/').filter(Boolean).at(-1);
if (!testDatabaseName || !/_(?:test|rebuild)$/.test(testDatabaseName)) {
  throw new Error('Throttling tests require a database ending in _test or _rebuild');
}

const prisma = new PrismaClient({ datasourceUrl: testDatabaseUrl });
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let prefix: string;
let queue: Queue<SendEmailJobData>;
let workers: Worker<SendEmailJobData>[];
let limiterClients: ReturnType<typeof createLimiterRedisClient>[];

async function clearDatabase(): Promise<void> {
  await prisma.email.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.sender.deleteMany();
  await prisma.user.deleteMany();
}

async function createEmails(
  count: number,
  options: { delayMs?: number; hourlyLimit?: number } = {},
) {
  const token = randomUUID();
  const user = await prisma.user.create({
    data: {
      googleSub: `throttle-${token}`,
      email: `${token}@user.test`,
      name: 'Throttle Test User',
    },
  });
  const sender = await prisma.sender.create({
    data: {
      userId: user.id,
      fromName: 'Throttle Sender',
      fromEmail: `${token}@ethereal.email`,
    },
  });
  const campaign = await prisma.campaign.create({
    data: {
      userId: user.id,
      senderId: sender.id,
      subject: 'Throttled campaign',
      body: 'Throttled body',
      startAt: new Date('2029-01-01T00:00:00.000Z'),
      delayMs: options.delayMs ?? 0,
      hourlyLimit: options.hourlyLimit ?? 5,
      totalRecipients: count,
      idempotencyKey: `throttle-${token}`,
    },
  });
  const emails = await Promise.all(
    Array.from({ length: count }, (_, index) => {
      const id = randomUUID();
      return prisma.email.create({
        data: {
          id,
          userId: user.id,
          senderId: sender.id,
          campaignId: campaign.id,
          recipientEmail: `${index}-${token}@recipient.test`,
          originalScheduledAt: new Date('2029-01-01T00:00:00.000Z'),
          scheduledAt: new Date('2029-01-01T00:00:00.000Z'),
          bullJobId: makeEmailJobId(id),
        },
      });
    }),
  );
  return { user, sender, campaign, emails };
}

function fakeSender(): EmailSender & { send: ReturnType<typeof vi.fn> } {
  return {
    send: vi.fn(async (input: DeliveryInput) => ({
      messageId: makeSmtpMessageId(input.emailId),
      previewUrl: null,
    })),
    close: vi.fn(),
  };
}

function realPermitGate(): RedisSendPermitGate {
  const client = createLimiterRedisClient(redisUrl);
  limiterClients.push(client);
  return new RedisSendPermitGate(client);
}

function startWorker(options: {
  sender: EmailSender;
  permitGate: SendPermitGate;
  now: () => Date;
  concurrency: number;
  name: string;
  minDelayMs?: number;
  hourlyLimit?: number;
}): Worker<SendEmailJobData> {
  const processor = new EmailProcessor({
    prisma,
    emailSender: options.sender,
    sendPermitGate: options.permitGate,
    platformLimits: {
      minSendDelayMs: options.minDelayMs ?? 0,
      maxEmailsPerHourPerSender: options.hourlyLimit ?? 1_000,
    },
    logger,
    now: options.now,
  });
  const worker = createEmailWorker({
    redisUrl,
    concurrency: options.concurrency,
    processor,
    logger,
    prefix,
    workerName: options.name,
  });
  workers.push(worker);
  return worker;
}

async function enqueueAll(emails: readonly { id: string }[]): Promise<void> {
  await queue.addBulk(
    emails.map((email) => ({
      name: SEND_EMAIL_JOB_NAME,
      data: { emailId: email.id },
      opts: { jobId: makeEmailJobId(email.id) },
    })),
  );
}

async function waitFor(assertion: () => Promise<void> | void): Promise<void> {
  await vi.waitFor(assertion, { timeout: 10_000, interval: 20 });
}

beforeEach(async () => {
  await clearDatabase();
  prefix = `reachinbox-throttle-test-${randomUUID()}`;
  workers = [];
  limiterClients = [];
  queue = new Queue<SendEmailJobData>(EMAIL_QUEUE_NAME, {
    connection: { url: redisUrl, maxRetriesPerRequest: 1 },
    prefix,
  });
  await queue.waitUntilReady();
});

afterEach(async () => {
  await Promise.all(workers.map((worker) => worker.close()));
  await queue.obliterate({ force: true });
  await queue.close();
  await Promise.all(limiterClients.map((client) => client.quit()));
  await clearDatabase();
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

afterAll(() => prisma.$disconnect());

describe('Worker distributed throttling', () => {
  it('moves an early same-sender job to delayed while keeping its Email SCHEDULED', async () => {
    const records = await createEmails(2, { delayMs: 60_000, hourlyLimit: 10 });
    const sender = fakeSender();
    const now = new Date('2030-01-01T14:00:00.000Z');
    const worker = startWorker({
      sender,
      permitGate: realPermitGate(),
      now: () => now,
      concurrency: 1,
      name: 'spacing-worker',
      minDelayMs: 60_000,
    });
    await worker.waitUntilReady();

    await enqueueAll(records.emails);
    await waitFor(async () => {
      expect(sender.send).toHaveBeenCalledTimes(1);
      expect(await queue.getDelayedCount()).toBe(1);
    });

    const persisted = await prisma.email.findMany({ orderBy: { id: 'asc' } });
    expect(persisted.filter((email) => email.status === EmailStatus.SENT)).toHaveLength(1);
    const delayed = persisted.find((email) => email.status === EmailStatus.SCHEDULED);
    expect(delayed?.scheduledAt).toEqual(new Date('2030-01-01T14:01:00.000Z'));
    expect(delayed?.originalScheduledAt).toEqual(new Date('2029-01-01T00:00:00.000Z'));
    expect(persisted.every((email) => email.status !== EmailStatus.FAILED)).toBe(true);
  });

  it('shares a cap of five across two Workers for twenty due jobs', async () => {
    const records = await createEmails(20, { delayMs: 0, hourlyLimit: 5 });
    const sender = fakeSender();
    const now = new Date('2030-01-01T14:10:00.000Z');
    const first = startWorker({
      sender,
      permitGate: realPermitGate(),
      now: () => now,
      concurrency: 10,
      name: 'cap-worker-a',
      hourlyLimit: 5,
    });
    const second = startWorker({
      sender,
      permitGate: realPermitGate(),
      now: () => now,
      concurrency: 10,
      name: 'cap-worker-b',
      hourlyLimit: 5,
    });
    await Promise.all([first.waitUntilReady(), second.waitUntilReady()]);

    await enqueueAll(records.emails);
    await waitFor(async () => {
      expect(await prisma.email.count({ where: { status: EmailStatus.SENT } })).toBe(5);
      expect(await prisma.email.count({ where: { status: EmailStatus.SCHEDULED } })).toBe(15);
      expect(await queue.getDelayedCount()).toBe(15);
    });

    expect(sender.send).toHaveBeenCalledTimes(5);
    expect(await prisma.email.count({ where: { status: EmailStatus.FAILED } })).toBe(0);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        senderId: records.sender.id,
        reservationCount: 5,
        hourlyLimit: 5,
        limitReachedThisReservation: true,
      }),
      'Send permit reserved',
    );
  });

  it('does not let a capped sender block another sender', async () => {
    const senderARecords = await createEmails(2, { delayMs: 0, hourlyLimit: 1 });
    const senderBRecords = await createEmails(1, { delayMs: 0, hourlyLimit: 1 });
    const sender = fakeSender();
    const now = new Date('2030-01-01T14:10:00.000Z');
    const worker = startWorker({
      sender,
      permitGate: realPermitGate(),
      now: () => now,
      concurrency: 3,
      name: 'multi-sender-worker',
      hourlyLimit: 1,
    });
    await worker.waitUntilReady();

    await enqueueAll([...senderARecords.emails, ...senderBRecords.emails]);
    await waitFor(async () => {
      expect(await prisma.email.count({ where: { status: EmailStatus.SENT } })).toBe(2);
      expect(await queue.getDelayedCount()).toBe(1);
    });

    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(
      await prisma.email.count({
        where: { senderId: senderBRecords.sender.id, status: EmailStatus.SENT },
      }),
    ).toBe(1);
  });

  it('fails closed when the permit infrastructure fails', async () => {
    const records = await createEmails(1);
    const sender = fakeSender();
    const worker = startWorker({
      sender,
      permitGate: { acquire: vi.fn().mockRejectedValue(new Error('Redis unavailable')) },
      now: () => new Date('2030-01-01T14:00:00.000Z'),
      concurrency: 1,
      name: 'failed-permit-worker',
    });
    await worker.waitUntilReady();

    await enqueueAll(records.emails);
    await waitFor(async () => expect(await queue.getFailedCount()).toBe(1));

    expect(sender.send).not.toHaveBeenCalled();
    await expect(
      prisma.email.findUniqueOrThrow({ where: { id: records.emails[0]!.id } }),
    ).resolves.toMatchObject({ status: EmailStatus.SCHEDULED });
  });

  it('does not send when BullMQ rescheduling fails after the durable schedule update', async () => {
    const records = await createEmails(1);
    const sender = fakeSender();
    const retryAt = new Date('2030-01-01T15:00:00.000Z');
    const processor = new EmailProcessor({
      prisma,
      emailSender: sender,
      sendPermitGate: {
        acquire: async () => ({
          allowed: false,
          reason: 'HOURLY_LIMIT',
          retryAt,
          count: 5,
          hourWindow: '2030-01-01T14',
        }),
      },
      platformLimits: { minSendDelayMs: 0, maxEmailsPerHourPerSender: 5 },
      logger,
      now: () => new Date('2030-01-01T14:00:00.000Z'),
    });

    await expect(
      processor.process({
        id: makeEmailJobId(records.emails[0]!.id),
        name: SEND_EMAIL_JOB_NAME,
        data: { emailId: records.emails[0]!.id },
        token: 'active-token',
        moveToDelayed: vi.fn().mockRejectedValue(new Error('Redis transition failed')),
      }),
    ).rejects.toThrow('Redis transition failed');

    expect(sender.send).not.toHaveBeenCalled();
    const persisted = await prisma.email.findUniqueOrThrow({
      where: { id: records.emails[0]!.id },
    });
    expect(persisted).toMatchObject({ status: EmailStatus.SCHEDULED, scheduledAt: retryAt });
    expect(persisted.originalScheduledAt).toEqual(new Date('2029-01-01T00:00:00.000Z'));
  });
});
