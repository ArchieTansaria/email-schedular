import { randomUUID } from 'node:crypto';

import { EmailStatus } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createTestCampaign,
  createTestEmail,
  createTestSender,
  createTestUser,
} from './factories.js';
import { clearDatabase, prisma } from './prisma.js';

async function expectPrismaError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

beforeEach(clearDatabase);

afterAll(async () => {
  await clearDatabase();
  await prisma.$disconnect();
});

describe('domain database invariants', () => {
  it('creates a user and rejects a duplicate Google subject', async () => {
    const user = await createTestUser({ googleSub: 'google-stable-subject' });

    expect(user.googleSub).toBe('google-stable-subject');
    await expectPrismaError(
      createTestUser({ googleSub: 'google-stable-subject', email: 'different@example.test' }),
      'P2002',
    );
  });

  it('supports multiple senders and campaigns for one user', async () => {
    const user = await createTestUser();
    const firstSender = await createTestSender(user.id);
    const secondSender = await createTestSender(user.id);
    await createTestCampaign(user.id, firstSender.id);
    await createTestCampaign(user.id, secondSender.id);

    const persisted = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      include: { senders: true, campaigns: true },
    });

    expect(persisted.senders).toHaveLength(2);
    expect(persisted.campaigns).toHaveLength(2);
  });

  it('enforces campaign idempotency per user, not globally', async () => {
    const firstUser = await createTestUser();
    const secondUser = await createTestUser();
    const firstSender = await createTestSender(firstUser.id);
    const secondSender = await createTestSender(secondUser.id);
    const idempotencyKey = 'abc';

    await createTestCampaign(firstUser.id, firstSender.id, { idempotencyKey });
    await expectPrismaError(
      createTestCampaign(firstUser.id, firstSender.id, { idempotencyKey }),
      'P2002',
    );
    await expect(
      createTestCampaign(secondUser.id, secondSender.id, { idempotencyKey }),
    ).resolves.toBeDefined();
  });

  it('requires campaign user and sender foreign keys to exist', async () => {
    const user = await createTestUser();
    const sender = await createTestSender(user.id);

    await expectPrismaError(createTestCampaign(randomUUID(), sender.id), 'P2003');
    await expectPrismaError(createTestCampaign(user.id, randomUUID()), 'P2003');
  });

  it('round-trips all email states, lifecycle metadata, timestamps, and relations', async () => {
    const user = await createTestUser();
    const sender = await createTestSender(user.id);
    const campaign = await createTestCampaign(user.id, sender.id, { totalRecipients: 4 });
    const originalScheduledAt = new Date('2030-01-01T10:00:00.123Z');
    const scheduledAt = new Date('2030-01-01T11:00:00.456Z');

    for (const status of Object.values(EmailStatus)) {
      await createTestEmail(user.id, sender.id, campaign.id, {
        status,
        originalScheduledAt,
        scheduledAt,
        ...(status === EmailStatus.SENT
          ? {
              sentAt: new Date('2030-01-01T11:00:01.000Z'),
              smtpMessageId: '<message@example.test>',
              previewUrl: 'https://ethereal.email/message/test',
            }
          : {}),
        ...(status === EmailStatus.FAILED ? { failureReason: 'Permanent SMTP failure' } : {}),
      });
    }

    const emails = await prisma.email.findMany({
      include: { campaign: true, sender: true, user: true },
      orderBy: { status: 'asc' },
    });

    expect(new Set(emails.map((email) => email.status))).toEqual(
      new Set(Object.values(EmailStatus)),
    );
    expect(
      emails.every(
        (email) => email.originalScheduledAt.getTime() === originalScheduledAt.getTime(),
      ),
    ).toBe(true);
    expect(emails.every((email) => email.scheduledAt.getTime() === scheduledAt.getTime())).toBe(
      true,
    );
    expect(emails.every((email) => email.user.id === user.id)).toBe(true);
    expect(emails.every((email) => email.sender.id === sender.id)).toBe(true);
    expect(emails.every((email) => email.campaign.id === campaign.id)).toBe(true);
  });

  it('rejects duplicate BullMQ job identity', async () => {
    const user = await createTestUser();
    const sender = await createTestSender(user.id);
    const campaign = await createTestCampaign(user.id, sender.id, { totalRecipients: 2 });

    await createTestEmail(user.id, sender.id, campaign.id, { bullJobId: 'email-fixed-id' });
    await expectPrismaError(
      createTestEmail(user.id, sender.id, campaign.id, { bullJobId: 'email-fixed-id' }),
      'P2002',
    );
  });

  it('allows only one Slack integration per user', async () => {
    const user = await createTestUser();
    const data = {
      userId: user.id,
      teamId: 'T123',
      teamName: 'Test Workspace',
      channelId: 'C123',
      channelName: 'alerts',
      accessTokenEncrypted: 'encrypted-token',
      webhookUrlEncrypted: 'encrypted-webhook',
    };

    await prisma.slackIntegration.create({ data });
    await expectPrismaError(
      prisma.slackIntegration.create({ data: { ...data, teamId: 'T456' } }),
      'P2002',
    );
  });

  it.each(['userId', 'senderId', 'campaignId'] as const)(
    'rejects an Email with an invalid %s foreign key',
    async (foreignKey) => {
      const user = await createTestUser();
      const sender = await createTestSender(user.id);
      const campaign = await createTestCampaign(user.id, sender.id);

      await expectPrismaError(
        createTestEmail(user.id, sender.id, campaign.id, { [foreignKey]: randomUUID() }),
        'P2003',
      );
    },
  );

  it('supports the indexed campaign and email query shapes', async () => {
    const user = await createTestUser();
    const sender = await createTestSender(user.id);
    const olderCampaign = await createTestCampaign(user.id, sender.id, { subject: 'Older' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newerCampaign = await createTestCampaign(user.id, sender.id, { subject: 'Newer' });
    const scheduledAt = new Date('2030-02-01T10:00:00.000Z');
    await createTestEmail(user.id, sender.id, olderCampaign.id, { scheduledAt });
    await createTestEmail(user.id, sender.id, newerCampaign.id, {
      scheduledAt: new Date('2030-02-01T11:00:00.000Z'),
    });

    const [scheduled, byCampaign, bySender, campaigns] = await Promise.all([
      prisma.email.findMany({
        where: {
          userId: user.id,
          status: EmailStatus.SCHEDULED,
          scheduledAt: { gte: scheduledAt },
        },
        orderBy: { scheduledAt: 'asc' },
      }),
      prisma.email.findMany({ where: { campaignId: olderCampaign.id } }),
      prisma.email.findMany({ where: { senderId: sender.id }, orderBy: { scheduledAt: 'asc' } }),
      prisma.campaign.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } }),
    ]);

    expect(scheduled).toHaveLength(2);
    expect(byCampaign).toHaveLength(1);
    expect(bySender).toHaveLength(2);
    expect(campaigns.map((campaign) => campaign.subject)).toEqual(['Newer', 'Older']);
  });

  it('restricts deletion of users, senders, and campaigns that own history', async () => {
    const user = await createTestUser();
    const sender = await createTestSender(user.id);
    const campaign = await createTestCampaign(user.id, sender.id);
    await createTestEmail(user.id, sender.id, campaign.id);

    await expectPrismaError(prisma.campaign.delete({ where: { id: campaign.id } }), 'P2003');
    await expectPrismaError(prisma.sender.delete({ where: { id: sender.id } }), 'P2003');
    await expectPrismaError(prisma.user.delete({ where: { id: user.id } }), 'P2003');
  });
});
