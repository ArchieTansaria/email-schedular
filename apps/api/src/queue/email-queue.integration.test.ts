import { randomUUID } from 'node:crypto';

import { makeEmailJobId } from '@reachinbox/shared/queue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EmailQueueProducer, type EnqueueEmailJobInput } from './email-queue.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const fixedNow = new Date('2030-01-01T10:00:00.000Z');
const logger = { error: vi.fn() };

let producer: EmailQueueProducer;
let prefix: string;

function queueInput(emailId: string, scheduledAt: Date = fixedNow): EnqueueEmailJobInput {
  return {
    emailId,
    bullJobId: makeEmailJobId(emailId),
    scheduledAt,
  };
}

beforeEach(async () => {
  prefix = `reachinbox-test-${randomUUID()}`;
  producer = new EmailQueueProducer({ redisUrl, logger, prefix });
  await producer.waitUntilReady();
});

afterEach(async () => {
  await producer.queue.obliterate({ force: true });
  await producer.close();
  logger.error.mockClear();
});

describe('email queue with real Redis', () => {
  it('connects and reports the Redis-backed BullMQ version', async () => {
    await expect(producer.queue.getVersion()).resolves.toMatch(/^bullmq:/);
  });

  it('stores immediate jobs with deterministic IDs and minimal payloads', async () => {
    const firstEmailId = randomUUID();
    const secondEmailId = randomUUID();

    await producer.enqueueEmailJob(queueInput(firstEmailId), fixedNow);
    await producer.enqueueEmailJob(queueInput(secondEmailId), fixedNow);

    const firstJob = await producer.queue.getJob(makeEmailJobId(firstEmailId));
    const secondJob = await producer.queue.getJob(makeEmailJobId(secondEmailId));

    expect(firstJob?.id).toBe(makeEmailJobId(firstEmailId));
    expect(firstJob?.data).toEqual({ emailId: firstEmailId });
    await expect(firstJob?.getState()).resolves.toBe('waiting');
    expect(secondJob?.id).toBe(makeEmailJobId(secondEmailId));
    expect(await producer.queue.getJobCountByTypes('waiting')).toBe(2);
  });

  it('stores future jobs in the delayed state', async () => {
    const emailId = randomUUID();
    const scheduledAt = new Date(fixedNow.getTime() + 60_000);

    const job = await producer.enqueueEmailJob(queueInput(emailId, scheduledAt), fixedNow);

    expect(job.opts.delay).toBe(60_000);
    await expect(job.getState()).resolves.toBe('delayed');
  });

  it('does not insert a second job with the same custom ID', async () => {
    const emailId = randomUUID();
    const input = queueInput(emailId, new Date(fixedNow.getTime() + 60_000));

    await producer.enqueueEmailJob(input, fixedNow);
    await producer.enqueueEmailJob(input, fixedNow);

    expect(await producer.queue.getJobCountByTypes('waiting', 'delayed')).toBe(1);
    await expect(producer.queue.getJob(input.bullJobId)).resolves.toBeDefined();
  });

  it('bulk-enqueues independent immediate and delayed jobs in one operation', async () => {
    const immediateEmailId = randomUUID();
    const delayedEmailId = randomUUID();
    const inputs = [
      queueInput(immediateEmailId, new Date(fixedNow.getTime() - 1_000)),
      queueInput(delayedEmailId, new Date(fixedNow.getTime() + 60_000)),
    ];

    const jobs = await producer.enqueueEmailJobsBulk(inputs, fixedNow);

    expect(jobs.map((job) => job.id)).toEqual(inputs.map((input) => input.bullJobId));
    expect(jobs.map((job) => job.data)).toEqual(
      inputs.map((input) => ({ emailId: input.emailId })),
    );
    await expect(jobs[0]?.getState()).resolves.toBe('waiting');
    await expect(jobs[1]?.getState()).resolves.toBe('delayed');
  });

  it('bulk-enqueues 1,000 delayed jobs without sequential queue additions', async () => {
    const scheduledAt = new Date(fixedNow.getTime() + 60_000);
    const inputs = Array.from({ length: 1_000 }, () => queueInput(randomUUID(), scheduledAt));

    const jobs = await producer.enqueueEmailJobsBulk(inputs, fixedNow);

    expect(jobs).toHaveLength(1_000);
    expect(await producer.queue.getJobCountByTypes('delayed')).toBe(1_000);
    expect(jobs[0]?.data).toEqual({ emailId: inputs[0]?.emailId });
    expect(jobs[999]?.id).toBe(inputs[999]?.bullJobId);
  });

  it('retains a delayed job after the producer Queue closes and reopens', async () => {
    const emailId = randomUUID();
    const input = queueInput(emailId, new Date(fixedNow.getTime() + 60_000));
    await producer.enqueueEmailJob(input, fixedNow);
    await producer.close();

    producer = new EmailQueueProducer({ redisUrl, logger, prefix });
    await producer.waitUntilReady();
    const persistedJob = await producer.queue.getJob(input.bullJobId);

    expect(persistedJob?.data).toEqual({ emailId });
    await expect(persistedJob?.getState()).resolves.toBe('delayed');
  });

  it('rejects a job ID that does not match the canonical email identity', async () => {
    const emailId = randomUUID();

    expect(() =>
      producer.enqueueEmailJob({
        emailId,
        bullJobId: 'email-a-different-id',
        scheduledAt: fixedNow,
      }),
    ).toThrow(`bullJobId must equal ${makeEmailJobId(emailId)}`);
    expect(await producer.queue.getJobCountByTypes('waiting', 'delayed')).toBe(0);
  });
});
