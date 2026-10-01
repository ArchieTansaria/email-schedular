import { randomUUID } from 'node:crypto';

import { EmailStatus, type Campaign, type Email, type Sender, type User } from '@prisma/client';

import { prisma } from './prisma.js';

export async function createTestUser(
  overrides: Partial<Pick<User, 'googleSub' | 'email' | 'name' | 'avatarUrl'>> = {},
): Promise<User> {
  const token = randomUUID();
  return prisma.user.create({
    data: {
      googleSub: `google-${token}`,
      email: `${token}@example.test`,
      name: 'Test User',
      avatarUrl: null,
      ...overrides,
    },
  });
}

export async function createTestSender(
  userId: string,
  overrides: Partial<Pick<Sender, 'fromName' | 'fromEmail' | 'active'>> = {},
): Promise<Sender> {
  const token = randomUUID();
  return prisma.sender.create({
    data: {
      userId,
      fromName: 'Test Sender',
      fromEmail: `${token}@sender.test`,
      active: true,
      ...overrides,
    },
  });
}

export async function createTestCampaign(
  userId: string,
  senderId: string,
  overrides: Partial<
    Pick<
      Campaign,
      | 'subject'
      | 'body'
      | 'startAt'
      | 'delayMs'
      | 'hourlyLimit'
      | 'totalRecipients'
      | 'idempotencyKey'
      | 'createdAt'
    >
  > = {},
): Promise<Campaign> {
  const token = randomUUID();
  return prisma.campaign.create({
    data: {
      userId,
      senderId,
      subject: 'Test campaign',
      body: 'Test body',
      startAt: new Date('2030-01-01T10:00:00.000Z'),
      delayMs: 2_000,
      hourlyLimit: 200,
      totalRecipients: 1,
      idempotencyKey: `campaign-${token}`,
      ...overrides,
    },
  });
}

export async function createTestEmail(
  userId: string,
  senderId: string,
  campaignId: string,
  overrides: Partial<
    Pick<
      Email,
      | 'campaignId'
      | 'userId'
      | 'senderId'
      | 'recipientEmail'
      | 'originalScheduledAt'
      | 'scheduledAt'
      | 'status'
      | 'bullJobId'
      | 'sentAt'
      | 'failureReason'
      | 'smtpMessageId'
      | 'previewUrl'
    >
  > = {},
): Promise<Email> {
  const token = randomUUID();
  return prisma.email.create({
    data: {
      userId,
      senderId,
      campaignId,
      recipientEmail: `${token}@recipient.test`,
      originalScheduledAt: new Date('2030-01-01T10:00:00.000Z'),
      scheduledAt: new Date('2030-01-01T10:00:00.000Z'),
      status: EmailStatus.SCHEDULED,
      bullJobId: `email-${token}`,
      ...overrides,
    },
  });
}
