import { randomUUID } from 'node:crypto';

import { EmailStatus, PrismaClient } from '@prisma/client';
import {
  createElasticsearchClient,
  EmailSearchService,
  parseSearchConfig,
  type EmailSearchProjection,
} from '@reachinbox/search';
import {
  EMAIL_QUEUE_NAME,
  SEND_EMAIL_JOB_NAME,
  makeEmailJobId,
  type SendEmailJobData,
} from '@reachinbox/shared/queue';
import { Queue, type Job, type Worker } from 'bullmq';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEmailWorker } from '../email-worker.js';
import type { SendPermitGate } from '../rate-limit/send-permit.js';
import { makeSmtpMessageId } from '../smtp/message.js';
import {
  AmbiguousDeliveryError,
  DefinitiveDeliveryError,
  SenderConfigurationError,
  type DeliveryInput,
  type DeliveryResult,
  type EmailSender,
} from '../smtp/types.js';
import { claimScheduledEmail, EmailProcessor } from './email-processor.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL is required for Worker integration tests');
const testDatabaseName = new URL(testDatabaseUrl).pathname.split('/').filter(Boolean).at(-1);
if (!testDatabaseName || !/_(?:test|rebuild)$/.test(testDatabaseName)) {
  throw new Error('Worker integration tests require a database ending in _test or _rebuild');
}

const prisma = new PrismaClient({ datasourceUrl: testDatabaseUrl });
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const elasticsearch = createElasticsearchClient(parseSearchConfig(process.env));
const searchIndex = `reachinbox-test-worker-${randomUUID()}`.toLowerCase();
const emailSearch = new EmailSearchService({
  client: elasticsearch,
  prisma,
  indexName: searchIndex,
});

let prefix: string;
let queue: Queue<SendEmailJobData>;
let workers: Array<Worker<SendEmailJobData>>;

interface TestEmailOptions {
  status?: EmailStatus;
  senderEmail?: string;
  senderActive?: boolean;
}

async function createTestEmail(options: TestEmailOptions = {}) {
  const token = randomUUID();
  const user = await prisma.user.create({
    data: {
      googleSub: `worker-${token}`,
      email: `${token}@user.test`,
      name: 'Worker Test User',
    },
  });
  const sender = await prisma.sender.create({
    data: {
      userId: user.id,
      fromName: 'Worker Test Sender',
      fromEmail: options.senderEmail ?? 'sender-a@ethereal.email',
      active: options.senderActive ?? true,
    },
  });
  const campaign = await prisma.campaign.create({
    data: {
      userId: user.id,
      senderId: sender.id,
      subject: 'Worker campaign subject',
      body: 'Worker campaign body',
      startAt: new Date('2020-01-01T10:00:00.000Z'),
      delayMs: 2_000,
      hourlyLimit: 200,
      totalRecipients: 1,
      idempotencyKey: `worker-${token}`,
    },
  });
  const email = await prisma.email.create({
    data: {
      userId: user.id,
      senderId: sender.id,
      campaignId: campaign.id,
      recipientEmail: `${token}@recipient.test`,
      originalScheduledAt: new Date('2020-01-01T10:00:00.000Z'),
      scheduledAt: new Date('2020-01-01T10:00:00.000Z'),
      status: options.status ?? EmailStatus.SCHEDULED,
      bullJobId: makeEmailJobId(token),
    },
  });
  return { user, sender, campaign, email };
}

function successfulSender(
  implementation: (input: DeliveryInput) => Promise<DeliveryResult> = async (input) => ({
    messageId: makeSmtpMessageId(input.emailId),
    previewUrl: `https://ethereal.email/message/${input.emailId}`,
  }),
): EmailSender & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  return { send: vi.fn(implementation), close: vi.fn() };
}

function startWorker(
  emailSender: EmailSender,
  concurrency = 3,
  workerName = `worker-${workers.length + 1}`,
  sendPermitGate: SendPermitGate = alwaysAllowPermit,
  searchProjection?: Pick<EmailSearchProjection, 'projectEmail'>,
) {
  const processor = new EmailProcessor({
    prisma,
    emailSender,
    sendPermitGate,
    platformLimits: { minSendDelayMs: 1, maxEmailsPerHourPerSender: 1_000 },
    logger,
    ...(searchProjection ? { searchProjection } : {}),
  });
  const worker = createEmailWorker({
    redisUrl,
    concurrency,
    processor,
    logger,
    prefix,
    workerName,
  });
  workers.push(worker);
  return worker;
}

const alwaysAllowPermit: SendPermitGate = {
  acquire: async ({ now, delayMs }) => ({
    allowed: true,
    count: 1,
    limitReachedThisReservation: false,
    hourWindow: now.toISOString().slice(0, 13),
    nextAllowedAt: new Date(now.getTime() + delayMs),
  }),
};

function waitForJobs(
  workerSet: readonly Worker<SendEmailJobData>[],
  expectedCount: number,
): Promise<Array<{ job: Job<SendEmailJobData>; state: 'completed' | 'failed' }>> {
  return new Promise((resolve, reject) => {
    const results: Array<{ job: Job<SendEmailJobData>; state: 'completed' | 'failed' }> = [];
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out after observing ${results.length}/${expectedCount} jobs`));
    }, 10_000);
    const completed = (job: Job<SendEmailJobData>) => record(job, 'completed');
    const failed = (job: Job<SendEmailJobData> | undefined) => {
      if (job) record(job, 'failed');
    };
    const cleanup = () => {
      clearTimeout(timeout);
      for (const worker of workerSet) {
        worker.off('completed', completed);
        worker.off('failed', failed);
      }
    };
    const record = (job: Job<SendEmailJobData>, state: 'completed' | 'failed') => {
      results.push({ job, state });
      if (results.length === expectedCount) {
        cleanup();
        resolve(results);
      }
    };
    for (const worker of workerSet) {
      worker.on('completed', completed);
      worker.on('failed', failed);
    }
  });
}

async function enqueue(emailId: string, jobId = makeEmailJobId(emailId)): Promise<void> {
  await queue.add(
    SEND_EMAIL_JOB_NAME,
    { emailId },
    { jobId, attempts: 5, backoff: { type: 'exponential', delay: 20 } },
  );
}

async function clearDatabase(): Promise<void> {
  await prisma.email.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.sender.deleteMany();
  await prisma.user.deleteMany();
}

beforeAll(() => emailSearch.ensureIndex());

beforeEach(async () => {
  await clearDatabase();
  prefix = `reachinbox-worker-test-${randomUUID()}`;
  workers = [];
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
  await clearDatabase();
  logger.info.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

afterAll(async () => {
  await elasticsearch.indices.delete({ index: searchIndex, ignore_unavailable: true });
  await Promise.all([elasticsearch.close(), prisma.$disconnect()]);
});

describe('atomic Email claim', () => {
  it('moves SCHEDULED to PROCESSING and rejects a second claim', async () => {
    const { email } = await createTestEmail();

    await expect(claimScheduledEmail(prisma, email.id)).resolves.toBe(true);
    await expect(claimScheduledEmail(prisma, email.id)).resolves.toBe(false);
    await expect(
      prisma.email.findUniqueOrThrow({ where: { id: email.id } }),
    ).resolves.toMatchObject({ status: EmailStatus.PROCESSING });
  });

  it.each([EmailStatus.PROCESSING, EmailStatus.SENT, EmailStatus.FAILED])(
    'does not claim an Email already in %s',
    async (status) => {
      const { email } = await createTestEmail({ status });
      await expect(claimScheduledEmail(prisma, email.id)).resolves.toBe(false);
    },
  );

  it('allows exactly one of two concurrent claims', async () => {
    const { email } = await createTestEmail();

    const claims = await Promise.all([
      claimScheduledEmail(prisma, email.id),
      claimScheduledEmail(prisma, email.id),
    ]);

    expect(claims.sort()).toEqual([false, true]);
  });
});

describe('BullMQ Worker delivery', () => {
  it('projects SENT only after PostgreSQL finalization', async () => {
    const { email } = await createTestEmail();
    const sender = successfulSender();
    const worker = startWorker(sender, 1, 'sent-projection-worker', alwaysAllowPermit, emailSearch);
    await worker.waitUntilReady();
    const result = waitForJobs([worker], 1);
    await enqueue(email.id);
    expect((await result)[0]?.state).toBe('completed');
    await elasticsearch.indices.refresh({ index: searchIndex });
    const projected = await elasticsearch.get({ index: searchIndex, id: email.id });
    expect(projected._source).toMatchObject({ emailId: email.id, status: 'SENT' });
  });

  it('projects definitive FAILED outcomes and their reason', async () => {
    const { email } = await createTestEmail();
    const sender = successfulSender(async () => {
      throw new DefinitiveDeliveryError('Mailbox rejected');
    });
    const worker = startWorker(
      sender,
      1,
      'failed-projection-worker',
      alwaysAllowPermit,
      emailSearch,
    );
    await worker.waitUntilReady();
    const result = waitForJobs([worker], 1);
    await enqueue(email.id);
    expect((await result)[0]?.state).toBe('failed');
    await elasticsearch.indices.refresh({ index: searchIndex });
    const projected = await elasticsearch.get({ index: searchIndex, id: email.id });
    expect(projected._source).toMatchObject({
      emailId: email.id,
      status: 'FAILED',
      failureReason: 'Mailbox rejected',
    });
  });

  it('keeps SENT authoritative and does not retry SMTP when Elasticsearch projection fails', async () => {
    const { email } = await createTestEmail();
    const sender = successfulSender();
    const projection = { projectEmail: vi.fn().mockRejectedValue(new Error('ES unavailable')) };
    const worker = startWorker(
      sender,
      1,
      'projection-failure-worker',
      alwaysAllowPermit,
      projection,
    );
    await worker.waitUntilReady();
    const result = waitForJobs([worker], 1);

    await enqueue(email.id);

    expect((await result)[0]?.state).toBe('completed');
    expect(await prisma.email.findUniqueOrThrow({ where: { id: email.id } })).toMatchObject({
      status: EmailStatus.SENT,
    });
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(projection.projectEmail).toHaveBeenCalledWith(email.id);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ emailId: email.id, operation: 'project-email' }),
      expect.stringContaining('Elasticsearch'),
    );
  });

  it('completes an orphaned queue job without attempting SMTP', async () => {
    const sender = successfulSender();
    const worker = startWorker(sender);
    await worker.waitUntilReady();
    const settled = waitForJobs([worker], 1);

    await enqueue(randomUUID());

    await expect(settled).resolves.toMatchObject([{ state: 'completed' }]);
    expect(sender.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ emailId: expect.any(String) }),
      'Queue job references a missing Email',
    );
  });

  it('consumes a job and persists successful SMTP evidence', async () => {
    const { email } = await createTestEmail();
    const attachments = [
      {
        filename: 'notes.txt',
        contentType: 'text/plain',
        contentBase64: Buffer.from('SMTP attachment').toString('base64'),
      },
    ];
    await prisma.campaign.update({
      where: { id: email.campaignId },
      data: { bodyHtml: '<p><strong>Worker campaign body</strong></p>', attachments },
    });
    const sender = successfulSender();
    const worker = startWorker(sender);
    await worker.waitUntilReady();
    const settled = waitForJobs([worker], 1);

    await enqueue(email.id);
    await expect(settled).resolves.toMatchObject([{ state: 'completed' }]);

    const delivered = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
    expect(sender.send).toHaveBeenCalledOnce();
    expect(sender.send).toHaveBeenCalledWith(
      expect.objectContaining({
        emailId: email.id,
        senderName: 'Worker Test Sender',
        senderEmail: 'sender-a@ethereal.email',
        recipientEmail: email.recipientEmail,
        subject: 'Worker campaign subject',
        body: 'Worker campaign body',
        bodyHtml: '<p><strong>Worker campaign body</strong></p>',
        attachments,
      }),
    );
    expect(delivered).toMatchObject({
      status: EmailStatus.SENT,
      smtpMessageId: makeSmtpMessageId(email.id),
      previewUrl: `https://ethereal.email/message/${email.id}`,
      failureReason: null,
    });
    expect(delivered.sentAt).toBeInstanceOf(Date);
  });

  it('does not send again after completed-job removal and recreation', async () => {
    const { email } = await createTestEmail();
    const sender = successfulSender();
    const worker = startWorker(sender);
    await worker.waitUntilReady();
    let settled = waitForJobs([worker], 1);

    await enqueue(email.id);
    await settled;
    await (await queue.getJob(makeEmailJobId(email.id)))!.remove();

    settled = waitForJobs([worker], 1);
    await enqueue(email.id);
    await settled;

    expect(sender.send).toHaveBeenCalledOnce();
    await expect(
      prisma.email.findUniqueOrThrow({ where: { id: email.id } }),
    ).resolves.toMatchObject({ status: EmailStatus.SENT });
  });

  it.each([EmailStatus.PROCESSING, EmailStatus.FAILED])(
    'does not send an Email already in %s',
    async (status) => {
      const { email } = await createTestEmail({ status });
      const sender = successfulSender();
      const worker = startWorker(sender);
      await worker.waitUntilReady();
      const settled = waitForJobs([worker], 1);

      await enqueue(email.id);
      await settled;

      expect(sender.send).not.toHaveBeenCalled();
      await expect(
        prisma.email.findUniqueOrThrow({ where: { id: email.id } }),
      ).resolves.toMatchObject({ status });
    },
  );

  it('marks a definitive pre-acceptance failure FAILED and never retries SMTP', async () => {
    const { email } = await createTestEmail();
    const sender = successfulSender(async () => {
      throw new DefinitiveDeliveryError('SMTP permanently rejected the message');
    });
    const worker = startWorker(sender);
    await worker.waitUntilReady();
    let settled = waitForJobs([worker], 1);

    await enqueue(email.id);
    expect(await settled).toMatchObject([{ state: 'failed' }]);
    await expect(
      prisma.email.findUniqueOrThrow({ where: { id: email.id } }),
    ).resolves.toMatchObject({
      status: EmailStatus.FAILED,
      failureReason: 'SMTP permanently rejected the message',
    });

    settled = waitForJobs([worker], 1);
    await enqueue(email.id, `duplicate-${randomUUID()}`);
    await settled;
    expect(sender.send).toHaveBeenCalledOnce();
  });

  it('keeps an ambiguous SMTP outcome PROCESSING and never retries SMTP', async () => {
    const { email } = await createTestEmail();
    const sender = successfulSender(async () => {
      throw new AmbiguousDeliveryError('SMTP delivery outcome is uncertain');
    });
    const worker = startWorker(sender, 3, undefined, alwaysAllowPermit, emailSearch);
    await worker.waitUntilReady();
    let settled = waitForJobs([worker], 1);

    await enqueue(email.id);
    expect(await settled).toMatchObject([{ state: 'failed' }]);
    await expect(
      prisma.email.findUniqueOrThrow({ where: { id: email.id } }),
    ).resolves.toMatchObject({
      status: EmailStatus.PROCESSING,
      failureReason: 'SMTP outcome is uncertain; automatic resend disabled',
    });
    await elasticsearch.indices.refresh({ index: searchIndex });
    await expect(elasticsearch.get({ index: searchIndex, id: email.id })).resolves.toMatchObject({
      _source: { status: 'PROCESSING' },
    });

    settled = waitForJobs([worker], 1);
    await enqueue(email.id, `duplicate-${randomUUID()}`);
    await settled;
    expect(sender.send).toHaveBeenCalledOnce();
  });

  it('marks inactive and unmapped sender configuration as definitive failure', async () => {
    const inactive = await createTestEmail({ senderActive: false });
    const unmapped = await createTestEmail({ senderEmail: 'unmapped@ethereal.email' });
    const mappedSender = successfulSender(async (input) => {
      if (input.senderEmail === 'unmapped@ethereal.email') {
        throw new SenderConfigurationError();
      }
      return {
        messageId: makeSmtpMessageId(input.emailId),
        previewUrl: null,
      };
    });
    const worker = startWorker(mappedSender);
    await worker.waitUntilReady();
    const settled = waitForJobs([worker], 2);

    await queue.addBulk([
      { name: SEND_EMAIL_JOB_NAME, data: { emailId: inactive.email.id } },
      { name: SEND_EMAIL_JOB_NAME, data: { emailId: unmapped.email.id } },
    ]);
    expect((await settled).map((result) => result.state)).toEqual(['failed', 'failed']);
    const statuses = await prisma.email.findMany({
      where: { id: { in: [inactive.email.id, unmapped.email.id] } },
      select: { status: true },
    });
    expect(statuses.every(({ status }) => status === EmailStatus.FAILED)).toBe(true);
    expect(mappedSender.send).toHaveBeenCalledOnce();
  });

  it('fails malformed payloads without attempting SMTP', async () => {
    const sender = successfulSender();
    const worker = startWorker(sender);
    await worker.waitUntilReady();
    const settled = waitForJobs([worker], 1);

    await queue.add(SEND_EMAIL_JOB_NAME, { emailId: 'not-a-uuid' });

    expect(await settled).toMatchObject([{ state: 'failed' }]);
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('applies configured concurrency without exceeding it', async () => {
    const records = await Promise.all(Array.from({ length: 6 }, () => createTestEmail()));
    let active = 0;
    let peak = 0;
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sender = successfulSender(async (input) => {
      active += 1;
      started += 1;
      peak = Math.max(peak, active);
      if (started === 3) release();
      await gate;
      active -= 1;
      return { messageId: makeSmtpMessageId(input.emailId), previewUrl: null };
    });
    const worker = startWorker(sender, 3);
    await worker.waitUntilReady();
    const settled = waitForJobs([worker], records.length);

    await queue.addBulk(
      records.map(({ email }) => ({
        name: SEND_EMAIL_JOB_NAME,
        data: { emailId: email.id },
      })),
    );
    await settled;

    expect(peak).toBe(3);
    expect(sender.send).toHaveBeenCalledTimes(6);
  });

  it('allows only one SMTP attempt across two Worker instances', async () => {
    const { email } = await createTestEmail();
    const sender = successfulSender();
    const first = startWorker(sender, 2, 'worker-a');
    const second = startWorker(sender, 2, 'worker-b');
    await Promise.all([first.waitUntilReady(), second.waitUntilReady()]);
    const settled = waitForJobs([first, second], 2);

    await queue.addBulk([
      {
        name: SEND_EMAIL_JOB_NAME,
        data: { emailId: email.id },
        opts: { jobId: `duplicate-a-${randomUUID()}` },
      },
      {
        name: SEND_EMAIL_JOB_NAME,
        data: { emailId: email.id },
        opts: { jobId: `duplicate-b-${randomUUID()}` },
      },
    ]);
    await settled;

    expect(sender.send).toHaveBeenCalledOnce();
    await expect(
      prisma.email.findUniqueOrThrow({ where: { id: email.id } }),
    ).resolves.toMatchObject({ status: EmailStatus.SENT });
  });
});
