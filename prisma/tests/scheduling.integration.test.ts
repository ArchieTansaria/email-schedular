import { randomUUID } from 'node:crypto';

import { EmailStatus } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CampaignScheduler,
  type CampaignSchedulerOptions,
} from '../../apps/api/src/modules/campaigns/campaign-scheduler.js';
import {
  CampaignEnqueueError,
  IdempotencyConflictError,
  SenderUnavailableError,
} from '../../apps/api/src/modules/campaigns/errors.js';
import type { ScheduleCampaignInput } from '../../apps/api/src/modules/campaigns/validation.js';
import { EmailQueueProducer } from '../../apps/api/src/queue/email-queue.js';
import { makeEmailJobId } from '../../packages/shared/src/queue.js';
import { createTestSender, createTestUser } from './factories.js';
import { clearDatabase, prisma } from './prisma.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const fixedNow = new Date('2030-01-01T10:00:00.000Z');
const limits = {
  MIN_SEND_DELAY_MS: 2_000,
  MAX_EMAILS_PER_HOUR_PER_SENDER: 200,
} as const;
const logger = { error: vi.fn() };

let producer: EmailQueueProducer;

function inputFor(
  userId: string,
  senderId: string,
  overrides: Partial<ScheduleCampaignInput> = {},
): ScheduleCampaignInput {
  return {
    userId,
    senderId,
    subject: '  Campaign subject  ',
    body: '  Campaign body  ',
    startAt: new Date('2030-01-01T10:01:00.000Z'),
    delayMs: 2_000,
    hourlyLimit: 200,
    idempotencyKey: `request-${randomUUID()}`,
    recipients: [' Alice@Example.com ', 'alice@example.com', 'bob@example.com'],
    ...overrides,
  };
}

function scheduler(
  options: Partial<Pick<CampaignSchedulerOptions, 'producer' | 'now' | 'generateEmailId'>> = {},
): CampaignScheduler {
  return new CampaignScheduler({
    prisma,
    producer,
    limits,
    logger,
    now: () => fixedNow,
    ...options,
  });
}

beforeEach(async () => {
  await clearDatabase();
  producer = new EmailQueueProducer({
    redisUrl,
    logger,
    prefix: `reachinbox-scheduling-test-${randomUUID()}`,
  });
  await producer.waitUntilReady();
});

afterEach(async () => {
  await producer.queue.obliterate({ force: true });
  await producer.close();
  await clearDatabase();
  logger.error.mockClear();
});

afterAll(() => prisma.$disconnect());

describe('campaign scheduling orchestration', () => {
  it('atomically persists normalized Campaign and Email rows before enqueuing jobs', async () => {
    const user = await createTestUser();
    const sender = await createTestSender(user.id);
    const result = await scheduler().scheduleCampaign(inputFor(user.id, sender.id));

    const campaign = await prisma.campaign.findUniqueOrThrow({
      where: { id: result.campaignId },
      include: { emails: { orderBy: { scheduledAt: 'asc' } } },
    });

    expect(campaign).toMatchObject({
      subject: 'Campaign subject',
      body: 'Campaign body',
      totalRecipients: 2,
      userId: user.id,
      senderId: sender.id,
    });
    expect(campaign.emails.map((email) => email.recipientEmail)).toEqual([
      'alice@example.com',
      'bob@example.com',
    ]);
    expect(campaign.emails.every((email) => email.status === EmailStatus.SCHEDULED)).toBe(true);
    expect(
      campaign.emails.every(
        (email) =>
          email.originalScheduledAt.getTime() === email.scheduledAt.getTime() &&
          email.bullJobId === makeEmailJobId(email.id) &&
          email.sentAt === null &&
          email.failureReason === null &&
          email.smtpMessageId === null &&
          email.previewUrl === null &&
          !('subject' in email) &&
          !('body' in email),
      ),
    ).toBe(true);

    for (const email of campaign.emails) {
      const job = await producer.queue.getJob(email.bullJobId);
      expect(job?.data).toEqual({ emailId: email.id });
      await expect(job?.getState()).resolves.toBe('delayed');
    }
    expect(result).toEqual({
      campaignId: campaign.id,
      totalRecipients: 2,
      startAt: campaign.startAt,
      firstScheduledAt: campaign.emails[0]?.scheduledAt,
      lastScheduledAt: campaign.emails[1]?.scheduledAt,
    });
  });

  it('rejects a sender owned by another user without writes or jobs', async () => {
    const owner = await createTestUser();
    const otherUser = await createTestUser();
    const sender = await createTestSender(owner.id);

    await expect(
      scheduler().scheduleCampaign(inputFor(otherUser.id, sender.id)),
    ).rejects.toBeInstanceOf(SenderUnavailableError);
    await expectNoCampaignDataOrJobs();
  });

  it('rejects a missing sender without writes or jobs', async () => {
    const user = await createTestUser();

    await expect(
      scheduler().scheduleCampaign(inputFor(user.id, randomUUID())),
    ).rejects.toBeInstanceOf(SenderUnavailableError);
    await expectNoCampaignDataOrJobs();
  });

  it('rejects an inactive sender without writes or jobs', async () => {
    const user = await createTestUser();
    const sender = await createTestSender(user.id, { active: false });

    await expect(scheduler().scheduleCampaign(inputFor(user.id, sender.id))).rejects.toBeInstanceOf(
      SenderUnavailableError,
    );
    await expectNoCampaignDataOrJobs();
  });

  it('rolls back the Campaign when Email persistence fails and enqueues nothing', async () => {
    const user = await createTestUser();
    const sender = await createTestSender(user.id);
    const duplicateEmailId = randomUUID();

    await expect(
      scheduler({ generateEmailId: () => duplicateEmailId }).scheduleCampaign(
        inputFor(user.id, sender.id),
      ),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expectNoCampaignDataOrJobs();
  });

  it('returns and re-enqueues the existing campaign on a sequential idempotent retry', async () => {
    const user = await createTestUser();
    const sender = await createTestSender(user.id);
    const input = inputFor(user.id, sender.id, { idempotencyKey: 'same-request' });

    const first = await scheduler().scheduleCampaign(input);
    const second = await scheduler().scheduleCampaign(input);

    expect(second).toEqual(first);
    expect(await prisma.campaign.count()).toBe(1);
    expect(await prisma.email.count()).toBe(2);
    expect(await producer.queue.getJobCountByTypes('waiting', 'delayed')).toBe(2);
  });

  it('rejects a conflicting payload that reuses an existing idempotency key', async () => {
    const user = await createTestUser();
    const sender = await createTestSender(user.id);
    const input = inputFor(user.id, sender.id, { idempotencyKey: 'conflicting-request' });

    const first = await scheduler().scheduleCampaign(input);

    await expect(
      scheduler().scheduleCampaign({ ...input, subject: 'Different subject' }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: first.campaignId } });
    expect(campaign.subject).toBe('Campaign subject');
    expect(await prisma.campaign.count()).toBe(1);
    expect(await prisma.email.count()).toBe(2);
    expect(await producer.queue.getJobCountByTypes('waiting', 'delayed')).toBe(2);
  });

  it('allows different users to use the same idempotency key', async () => {
    const firstUser = await createTestUser();
    const secondUser = await createTestUser();
    const firstSender = await createTestSender(firstUser.id);
    const secondSender = await createTestSender(secondUser.id);

    await scheduler().scheduleCampaign(
      inputFor(firstUser.id, firstSender.id, { idempotencyKey: 'shared-key' }),
    );
    await scheduler().scheduleCampaign(
      inputFor(secondUser.id, secondSender.id, { idempotencyKey: 'shared-key' }),
    );

    expect(await prisma.campaign.count()).toBe(2);
    expect(await prisma.email.count()).toBe(4);
    expect(await producer.queue.getJobCountByTypes('waiting', 'delayed')).toBe(4);
  });

  it('uses the database unique constraint to resolve concurrent duplicate requests', async () => {
    const user = await createTestUser();
    const sender = await createTestSender(user.id);
    const input = inputFor(user.id, sender.id, { idempotencyKey: 'concurrent-request' });

    const [first, second] = await Promise.all([
      scheduler().scheduleCampaign(input),
      scheduler().scheduleCampaign(input),
    ]);

    expect(second.campaignId).toBe(first.campaignId);
    expect(await prisma.campaign.count()).toBe(1);
    expect(await prisma.email.count()).toBe(2);
    expect(await producer.queue.getJobCountByTypes('waiting', 'delayed')).toBe(2);
  });

  it('preserves SCHEDULED rows after enqueue failure and repairs them on idempotent retry', async () => {
    const user = await createTestUser();
    const sender = await createTestSender(user.id);
    const input = inputFor(user.id, sender.id, { idempotencyKey: 'recoverable-request' });
    const enqueueFailure = new Error('controlled Redis failure');
    const failingProducer = {
      enqueueEmailJobsBulk: vi.fn().mockRejectedValue(enqueueFailure),
    };

    await expect(
      scheduler({ producer: failingProducer }).scheduleCampaign(input),
    ).rejects.toBeInstanceOf(CampaignEnqueueError);

    const persistedCampaign = await prisma.campaign.findUniqueOrThrow({
      where: {
        userId_idempotencyKey: { userId: user.id, idempotencyKey: input.idempotencyKey },
      },
      include: { emails: true },
    });
    expect(persistedCampaign.emails).toHaveLength(2);
    expect(persistedCampaign.emails.every((email) => email.status === EmailStatus.SCHEDULED)).toBe(
      true,
    );
    expect(await producer.queue.getJobCountByTypes('waiting', 'delayed')).toBe(0);

    const repaired = await scheduler().scheduleCampaign(input);

    expect(repaired.campaignId).toBe(persistedCampaign.id);
    expect(await prisma.campaign.count()).toBe(1);
    expect(await prisma.email.count()).toBe(2);
    expect(await producer.queue.getJobCountByTypes('waiting', 'delayed')).toBe(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ campaignId: persistedCampaign.id, cause: enqueueFailure }),
      'Campaign persisted but queue enqueue failed',
    );
  });

  it('persists and enqueues 1,000 recipients with deterministic identities and hourly planning', async () => {
    const user = await createTestUser();
    const sender = await createTestSender(user.id);
    const recipients = Array.from(
      { length: 1_000 },
      (_, index) => `recipient-${index}@example.test`,
    );

    const result = await scheduler().scheduleCampaign(
      inputFor(user.id, sender.id, {
        idempotencyKey: 'one-thousand',
        recipients,
        startAt: fixedNow,
      }),
    );
    const emails = await prisma.email.findMany({
      where: { campaignId: result.campaignId },
      orderBy: { scheduledAt: 'asc' },
    });
    const countsByHour = new Map<string, number>();
    for (const email of emails) {
      const hour = email.scheduledAt.toISOString().slice(0, 13);
      countsByHour.set(hour, (countsByHour.get(hour) ?? 0) + 1);
    }

    expect(await prisma.campaign.count()).toBe(1);
    expect(emails).toHaveLength(1_000);
    expect(emails.every((email) => email.bullJobId === makeEmailJobId(email.id))).toBe(true);
    expect(Math.max(...countsByHour.values())).toBeLessThanOrEqual(200);
    expect(await producer.queue.getJobCountByTypes('waiting', 'delayed')).toBe(1_000);
  });
});

async function expectNoCampaignDataOrJobs(): Promise<void> {
  expect(await prisma.campaign.count()).toBe(0);
  expect(await prisma.email.count()).toBe(0);
  expect(await producer.queue.getJobCountByTypes('waiting', 'delayed')).toBe(0);
}
