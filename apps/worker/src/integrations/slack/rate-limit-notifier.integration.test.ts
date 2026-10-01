import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { SecretCipher, SlackRateLimitNotifier } from '@reachinbox/slack';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required');
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: 1,
});
const prefix = `slack-alert-test-${randomUUID()}`;
const cipher = new SecretCipher('test-encryption-key-that-is-at-least-32-characters');
const slackClient = { postWebhook: vi.fn(async () => undefined) };

async function clearDatabase() {
  await prisma.email.deleteMany();
  await prisma.slackIntegration.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.sender.deleteMany();
  await prisma.user.deleteMany();
}

async function createOwner(connected: boolean) {
  const token = randomUUID();
  const user = await prisma.user.create({
    data: { googleSub: token, email: `${token}@test.local`, name: 'Owner' },
  });
  const sender = await prisma.sender.create({
    data: { userId: user.id, fromName: 'Sender', fromEmail: 'sender@example.test' },
  });
  if (connected) {
    await prisma.slackIntegration.create({
      data: {
        userId: user.id,
        teamId: 'T1',
        teamName: 'Workspace',
        channelId: 'C1',
        channelName: '#alerts',
        accessTokenEncrypted: cipher.encrypt('xoxb-token'),
        webhookUrlEncrypted: cipher.encrypt('https://hooks.slack.com/services/T/B/secret'),
      },
    });
  }
  return { user, sender };
}

function notifier() {
  return new SlackRateLimitNotifier({ prisma, redis, cipher, client: slackClient, prefix });
}

function alertInput(userId: string, senderId: string, overrides = {}) {
  return {
    userId,
    senderId,
    senderEmail: 'sender@example.test',
    hourWindow: '2030-01-01T14',
    hourlyLimit: 5,
    limitReachedThisReservation: true,
    ...overrides,
  };
}

beforeAll(async () => {
  await Promise.all([prisma.$connect(), redis.ping()]);
});
beforeEach(async () => {
  await clearDatabase();
  slackClient.postWebhook.mockResolvedValue(undefined);
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

describe('SlackRateLimitNotifier', () => {
  it('is a no-op before the final allowed reservation or without an integration', async () => {
    const { user, sender } = await createOwner(false);
    await expect(
      notifier().notify(alertInput(user.id, sender.id, { limitReachedThisReservation: false })),
    ).resolves.toBe('not-reached');
    await expect(notifier().notify(alertInput(user.id, sender.id))).resolves.toBe('not-connected');
    expect(slackClient.postWebhook).not.toHaveBeenCalled();
  });

  it('deduplicates two Worker-style races for one sender and UTC window', async () => {
    const { user, sender } = await createOwner(true);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => notifier().notify(alertInput(user.id, sender.id))),
    );
    expect(results.filter((result) => result === 'sent')).toHaveLength(1);
    expect(results.filter((result) => result === 'duplicate')).toHaveLength(9);
    expect(slackClient.postWebhook).toHaveBeenCalledOnce();
    expect(slackClient.postWebhook).toHaveBeenCalledWith(
      'https://hooks.slack.com/services/T/B/secret',
      expect.stringMatching(
        /Sender: sender@example\.test[\s\S]*Limit: 5 emails\/hour[\s\S]*Window: 14:00–15:00 UTC/,
      ),
    );
  });

  it('allows independent alerts for another sender and a new hour', async () => {
    const { user, sender } = await createOwner(true);
    await notifier().notify(alertInput(user.id, sender.id));
    await notifier().notify(alertInput(user.id, randomUUID()));
    await notifier().notify(alertInput(user.id, sender.id, { hourWindow: '2030-01-01T15' }));
    expect(slackClient.postWebhook).toHaveBeenCalledTimes(3);
  });

  it('releases the Redis marker after provider failure so a later event can retry', async () => {
    const { user, sender } = await createOwner(true);
    slackClient.postWebhook.mockRejectedValueOnce(new Error('timeout'));
    await expect(notifier().notify(alertInput(user.id, sender.id))).rejects.toThrow('timeout');
    await expect(notifier().notify(alertInput(user.id, sender.id))).resolves.toBe('sent');
    expect(slackClient.postWebhook).toHaveBeenCalledTimes(2);
  });

  it('observes a connection added at runtime without recreating the notifier', async () => {
    const { user, sender } = await createOwner(false);
    const existingNotifier = notifier();
    await expect(existingNotifier.notify(alertInput(user.id, sender.id))).resolves.toBe(
      'not-connected',
    );
    await prisma.slackIntegration.create({
      data: {
        userId: user.id,
        teamId: 'T',
        teamName: 'Team',
        channelId: 'C',
        channelName: '#alerts',
        accessTokenEncrypted: cipher.encrypt('token'),
        webhookUrlEncrypted: cipher.encrypt('https://hooks.slack.com/services/T/B/new'),
      },
    });
    await expect(
      existingNotifier.notify(alertInput(user.id, sender.id, { hourWindow: '2030-01-01T15' })),
    ).resolves.toBe('sent');
  });
});
