import { randomUUID } from 'node:crypto';

import { EmailStatus, PrismaClient } from '@prisma/client';
import {
  EMAIL_QUEUE_NAME,
  SEND_EMAIL_JOB_NAME,
  makeEmailJobId,
  emailJobRetryOptions,
  type SendEmailJobData,
} from '@reachinbox/shared/queue';
import { Job, Worker, type Queue } from 'bullmq';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEmailWorker } from '../email-worker.js';
import { EmailProcessor } from '../processors/email-processor.js';
import { makeSmtpMessageId } from '../smtp/message.js';
import { AmbiguousDeliveryError, type DeliveryInput, type EmailSender } from '../smtp/types.js';
import type { SendPermitGate } from '../rate-limit/send-permit.js';
import { createRecoveryQueue, QueueReconciler } from './queue-reconciler.js';
import { startRecoveryLoop } from './recovery-loop.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL is required for reconciliation tests');
const testDatabaseName = new URL(testDatabaseUrl).pathname.split('/').filter(Boolean).at(-1);
if (!testDatabaseName || !/_(?:test|rebuild)$/.test(testDatabaseName)) {
  throw new Error('Reconciliation tests require a database ending in _test or _rebuild');
}

const prisma = new PrismaClient({ datasourceUrl: testDatabaseUrl });
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let prefix: string;
let queue: Queue<SendEmailJobData>;
let workers: Worker<SendEmailJobData>[];
let recoveryStops: Array<() => Promise<void>>;

const allowPermit: SendPermitGate['acquire'] = async ({ now, delayMs }) => ({
  allowed: true,
  count: 1,
  limitReachedThisReservation: false,
  hourWindow: now.toISOString().slice(0, 13),
  nextAllowedAt: new Date(now.getTime() + delayMs),
});

function deliveryWorker(
  acquire: SendPermitGate['acquire'] = allowPermit,
  send?: EmailSender['send'],
) {
  const sender = {
    send: vi.fn(
      send ??
        (async (input: DeliveryInput) => ({
          messageId: makeSmtpMessageId(input.emailId),
          previewUrl: null,
        })),
    ),
    close: vi.fn(),
  };
  const worker = createEmailWorker({
    redisUrl,
    prefix,
    concurrency: 2,
    logger,
    processor: new EmailProcessor({
      prisma,
      emailSender: sender,
      sendPermitGate: { acquire },
      logger,
      platformLimits: { minSendDelayMs: 1, maxEmailsPerHourPerSender: 200 },
    }),
  });
  workers.push(worker);
  return { worker, sender };
}

async function addRetryJob(emailId: string) {
  return queue.add(
    SEND_EMAIL_JOB_NAME,
    { emailId },
    {
      jobId: makeEmailJobId(emailId),
      ...emailJobRetryOptions({ EMAIL_JOB_ATTEMPTS: 2, EMAIL_JOB_BACKOFF_MS: 20 }),
    },
  );
}

async function clearDatabase(): Promise<void> {
  await prisma.email.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.sender.deleteMany();
  await prisma.user.deleteMany();
}

async function createEmail(options: { status?: EmailStatus; scheduledAt?: Date } = {}) {
  const token = randomUUID();
  const user = await prisma.user.create({
    data: {
      googleSub: `reconcile-${token}`,
      email: `${token}@user.test`,
      name: 'Reconciliation User',
    },
  });
  const sender = await prisma.sender.create({
    data: {
      userId: user.id,
      fromName: 'Reconciliation Sender',
      fromEmail: `${token}@ethereal.email`,
    },
  });
  const campaign = await prisma.campaign.create({
    data: {
      userId: user.id,
      senderId: sender.id,
      subject: 'Recovered campaign',
      body: 'Recovered body',
      startAt: options.scheduledAt ?? new Date(),
      delayMs: 2_000,
      hourlyLimit: 200,
      totalRecipients: 1,
      idempotencyKey: `reconcile-${token}`,
    },
  });
  const id = randomUUID();
  const scheduledAt = options.scheduledAt ?? new Date(Date.now() - 60_000);
  const email = await prisma.email.create({
    data: {
      id,
      userId: user.id,
      senderId: sender.id,
      campaignId: campaign.id,
      recipientEmail: `${token}@recipient.test`,
      originalScheduledAt: scheduledAt,
      scheduledAt,
      status: options.status ?? EmailStatus.SCHEDULED,
      bullJobId: makeEmailJobId(id),
    },
  });
  return { user, sender, campaign, email };
}

function reconciler(now = () => new Date()): QueueReconciler {
  return new QueueReconciler({ prisma, queue, logger, batchSize: 2, now });
}

async function waitFor(assertion: () => Promise<void> | void): Promise<void> {
  await vi.waitFor(assertion, { timeout: 10_000, interval: 20 });
}

beforeEach(async () => {
  await clearDatabase();
  prefix = `reachinbox-reconcile-test-${randomUUID()}`;
  workers = [];
  recoveryStops = [];
  queue = createRecoveryQueue(redisUrl, prefix);
  await queue.waitUntilReady();
});

afterEach(async () => {
  await Promise.all(recoveryStops.map((stop) => stop()));
  await Promise.all(workers.map((worker) => worker.close()));
  await queue.obliterate({ force: true });
  await queue.close();
  await clearDatabase();
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
  vi.restoreAllMocks();
});

afterAll(() => prisma.$disconnect());

describe('queue reconciliation', () => {
  it('retries a transient permit failure and sends once without restarting the worker', async () => {
    const { email } = await createEmail();
    const acquire = vi
      .fn<SendPermitGate['acquire']>()
      .mockRejectedValueOnce(new Error('Transient Redis failure'))
      .mockImplementation(allowPermit);
    const { worker, sender } = deliveryWorker(acquire);
    await worker.waitUntilReady();
    const job = await addRetryJob(email.id);

    await waitFor(async () => expect(await job.getState()).toBe('completed'));
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(sender.send).toHaveBeenCalledOnce();
    expect((await queue.getJob(job.id!))?.attemptsMade).toBe(2);
    expect((await prisma.email.findUniqueOrThrow({ where: { id: email.id } })).status).toBe(
      EmailStatus.SENT,
    );
  });

  it('recovers exhausted retries on a later polling pass without a worker restart', async () => {
    const { email } = await createEmail();
    let available = false;
    const acquire = vi.fn<SendPermitGate['acquire']>(async (input) => {
      if (!available) throw new Error('Permit service unavailable');
      return allowPermit(input);
    });
    const { worker, sender } = deliveryWorker(acquire);
    await worker.waitUntilReady();
    const job = await addRetryJob(email.id);
    await waitFor(async () => expect(await job.getState()).toBe('failed'));
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(sender.send).not.toHaveBeenCalled();
    expect((await prisma.email.findUniqueOrThrow({ where: { id: email.id } })).status).toBe(
      EmailStatus.SCHEDULED,
    );

    available = true;
    const recovery = reconciler();
    recoveryStops.push(
      startRecoveryLoop({ reconcile: () => recovery.reconcile(), intervalMs: 20, logger }),
    );
    await waitFor(async () =>
      expect((await prisma.email.findUniqueOrThrow({ where: { id: email.id } })).status).toBe(
        EmailStatus.SENT,
      ),
    );
    expect(sender.send).toHaveBeenCalledOnce();
  });

  it('respects scheduledAt after a failed moveToDelayed and does not consume a retry for the delay', async () => {
    const { email } = await createEmail();
    const retryAt = new Date(Date.now() + 800);
    const acquire = vi
      .fn<SendPermitGate['acquire']>()
      .mockResolvedValueOnce({
        allowed: false,
        reason: 'MIN_DELAY',
        retryAt,
        count: 1,
        hourWindow: new Date().toISOString().slice(0, 13),
      })
      .mockImplementation(allowPermit);
    vi.spyOn(Job.prototype, 'moveToDelayed').mockRejectedValueOnce(
      new Error('Redis transition failed'),
    );
    const { worker, sender } = deliveryWorker(acquire);
    await worker.waitUntilReady();
    const job = await addRetryJob(email.id);
    await waitFor(async () => {
      expect(await job.getState()).toBe('delayed');
      expect((await queue.getJob(job.id!))?.attemptsMade).toBe(1);
      expect(
        (await prisma.email.findUniqueOrThrow({ where: { id: email.id } })).scheduledAt,
      ).toEqual(retryAt);
    });
    expect(sender.send).not.toHaveBeenCalled();
    // The early retry only repairs the delayed transition, without reserving quota.
    expect(acquire).toHaveBeenCalledOnce();
    await waitFor(async () => expect(await job.getState()).toBe('completed'));
    expect(sender.send).toHaveBeenCalledOnce();
    expect(
      (await prisma.email.findUniqueOrThrow({ where: { id: email.id } })).sentAt!.getTime(),
    ).toBeGreaterThanOrEqual(retryAt.getTime());
  });

  it('lets concurrent reconcilers restore one terminal job without removing resumed work', async () => {
    const { email } = await createEmail();
    const failing = new Worker<SendEmailJobData>(
      EMAIL_QUEUE_NAME,
      async () => {
        throw new Error('Before SMTP');
      },
      {
        connection: { url: redisUrl, maxRetriesPerRequest: null },
        prefix,
      },
    );
    workers.push(failing);
    await failing.waitUntilReady();
    const job = await queue.add(
      SEND_EMAIL_JOB_NAME,
      { emailId: email.id },
      { jobId: makeEmailJobId(email.id) },
    );
    await waitFor(async () => expect(await job.getState()).toBe('failed'));
    await failing.close();
    workers = [];

    const reports = await Promise.all([reconciler().reconcile(), reconciler().reconcile()]);
    expect(reports.reduce((count, report) => count + report.terminalJobsRepaired, 0)).toBe(1);
    expect(await queue.getWaitingCount()).toBe(1);
    const first = deliveryWorker();
    const second = deliveryWorker();
    await Promise.all([first.worker.waitUntilReady(), second.worker.waitUntilReady()]);
    await waitFor(async () => expect(await job.getState()).toBe('completed'));
    expect(first.sender.send.mock.calls.length + second.sender.send.mock.calls.length).toBe(1);
  });

  it('does not retry or recover an ambiguous SMTP delivery even with an attempt budget', async () => {
    const { email } = await createEmail();
    const { worker, sender } = deliveryWorker(allowPermit, async () => {
      throw new AmbiguousDeliveryError('Unknown SMTP outcome');
    });
    await worker.waitUntilReady();
    const job = await addRetryJob(email.id);
    await waitFor(async () => expect(await job.getState()).toBe('failed'));
    expect((await queue.getJob(job.id!))?.attemptsMade).toBe(1);
    expect((await prisma.email.findUniqueOrThrow({ where: { id: email.id } })).status).toBe(
      EmailStatus.PROCESSING,
    );
    const report = await reconciler().reconcile();
    expect(report.jobsRestored).toBe(0);
    expect(await job.getState()).toBe('failed');
    expect(sender.send).toHaveBeenCalledOnce();
  });

  it('restores a missing future job with canonical identity, payload, and delay', async () => {
    const now = new Date('2030-01-01T14:00:00.000Z');
    const record = await createEmail({ scheduledAt: new Date('2030-01-01T14:01:00.000Z') });

    const report = await reconciler(() => now).reconcile();
    const job = await queue.getJob(makeEmailJobId(record.email.id));

    expect(report).toMatchObject({
      scheduledInspected: 1,
      jobsAlreadyPresent: 0,
      jobsRestored: 1,
      terminalJobsRepaired: 0,
    });
    expect(job).toMatchObject({
      id: makeEmailJobId(record.email.id),
      name: SEND_EMAIL_JOB_NAME,
      data: { emailId: record.email.id },
      delay: 60_000,
    });
    await expect(job?.getState()).resolves.toBe('delayed');
  });

  it('leaves an existing waiting or delayed job alone', async () => {
    const record = await createEmail({ scheduledAt: new Date('2030-01-01T14:01:00.000Z') });
    await queue.add(
      SEND_EMAIL_JOB_NAME,
      { emailId: record.email.id },
      { jobId: makeEmailJobId(record.email.id), delay: 60_000 },
    );

    const report = await reconciler(() => new Date('2030-01-01T14:00:00.000Z')).reconcile();

    expect(report).toMatchObject({ jobsAlreadyPresent: 1, jobsRestored: 0 });
    expect(await queue.getJobCountByTypes('delayed')).toBe(1);
  });

  it('repairs completed and failed jobs when PostgreSQL still says SCHEDULED', async () => {
    const completed = await createEmail();
    const failed = await createEmail();
    const terminalWorker = new Worker<SendEmailJobData>(
      EMAIL_QUEUE_NAME,
      async (job) => {
        if (job.data.emailId === failed.email.id) throw new Error('controlled failure');
      },
      { connection: { url: redisUrl, maxRetriesPerRequest: null }, prefix },
    );
    workers.push(terminalWorker);
    await terminalWorker.waitUntilReady();
    await queue.addBulk([
      {
        name: SEND_EMAIL_JOB_NAME,
        data: { emailId: completed.email.id },
        opts: { jobId: makeEmailJobId(completed.email.id) },
      },
      {
        name: SEND_EMAIL_JOB_NAME,
        data: { emailId: failed.email.id },
        opts: { jobId: makeEmailJobId(failed.email.id) },
      },
    ]);
    await waitFor(async () => {
      expect(await queue.getCompletedCount()).toBe(1);
      expect(await queue.getFailedCount()).toBe(1);
    });
    await terminalWorker.close();
    workers = [];

    const report = await reconciler().reconcile();

    expect(report).toMatchObject({
      scheduledInspected: 2,
      jobsRestored: 2,
      terminalJobsRepaired: 2,
    });
    await expect(queue.getJob(makeEmailJobId(completed.email.id))).resolves.not.toBeNull();
    await expect(queue.getJob(makeEmailJobId(failed.email.id))).resolves.not.toBeNull();
  });

  it('restores overdue jobs immediately and scans in bounded batches', async () => {
    const records = await Promise.all(Array.from({ length: 3 }, () => createEmail()));

    const report = await reconciler(() => new Date()).reconcile();

    expect(report).toMatchObject({ scheduledInspected: 3, jobsRestored: 3 });
    for (const record of records) {
      const job = await queue.getJob(makeEmailJobId(record.email.id));
      expect(job?.delay).toBe(0);
      await expect(job?.getState()).resolves.toBe('waiting');
    }
  });

  it('never queues PROCESSING, SENT, or FAILED records and reports PROCESSING visibility', async () => {
    const records = await Promise.all([
      createEmail({ status: EmailStatus.PROCESSING }),
      createEmail({ status: EmailStatus.SENT }),
      createEmail({ status: EmailStatus.FAILED }),
    ]);

    const report = await reconciler().reconcile();

    expect(report).toMatchObject({ scheduledInspected: 0, jobsRestored: 0, processingObserved: 1 });
    for (const record of records) {
      await expect(queue.getJob(makeEmailJobId(record.email.id))).resolves.toBeUndefined();
    }
    await expect(
      prisma.email.findUniqueOrThrow({ where: { id: records[0]!.email.id } }),
    ).resolves.toMatchObject({ status: EmailStatus.PROCESSING });
  });

  it('supports a non-mutating dry run', async () => {
    const record = await createEmail();

    const report = await reconciler().reconcile({ dryRun: true });

    expect(report).toMatchObject({ dryRun: true, scheduledInspected: 1, jobsRestored: 1 });
    await expect(queue.getJob(makeEmailJobId(record.email.id))).resolves.toBeUndefined();
  });

  it('preserves a future job across a Worker restart and sends it once when due', async () => {
    const scheduledAt = new Date(Date.now() + 1_000);
    const record = await createEmail({ scheduledAt });
    const firstReport = await reconciler().reconcile();
    expect(firstReport.jobsRestored).toBe(1);
    await expect((await queue.getJob(makeEmailJobId(record.email.id)))?.getState()).resolves.toBe(
      'delayed',
    );

    await queue.close();
    queue = createRecoveryQueue(redisUrl, prefix);
    await queue.waitUntilReady();
    const restartReport = await reconciler().reconcile();
    expect(restartReport).toMatchObject({ jobsAlreadyPresent: 1, jobsRestored: 0 });

    const sender: EmailSender & { send: ReturnType<typeof vi.fn> } = {
      send: vi.fn(async (input: DeliveryInput) => ({
        messageId: makeSmtpMessageId(input.emailId),
        previewUrl: null,
      })),
      close: vi.fn(),
    };
    const processor = new EmailProcessor({
      prisma,
      emailSender: sender,
      sendPermitGate: {
        acquire: async ({ now, delayMs }) => ({
          allowed: true,
          count: 1,
          limitReachedThisReservation: false,
          hourWindow: now.toISOString().slice(0, 13),
          nextAllowedAt: new Date(now.getTime() + delayMs),
        }),
      },
      platformLimits: { minSendDelayMs: 1, maxEmailsPerHourPerSender: 200 },
      logger,
    });
    const restartedWorker = createEmailWorker({
      redisUrl,
      concurrency: 1,
      processor,
      logger,
      prefix,
      workerName: 'restart-worker',
    });
    workers.push(restartedWorker);
    await restartedWorker.waitUntilReady();

    await waitFor(async () => {
      await expect(
        prisma.email.findUniqueOrThrow({ where: { id: record.email.id } }),
      ).resolves.toMatchObject({ status: EmailStatus.SENT });
    });
    expect(sender.send).toHaveBeenCalledOnce();
  });
});
