import { randomUUID } from 'node:crypto';

import { EmailStatus, PrismaClient } from '@prisma/client';
import type { RequestHandler } from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../../app.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL is required for email read tests');
const databaseName = new URL(testDatabaseUrl).pathname.split('/').filter(Boolean).at(-1);
if (!databaseName || !/_(?:test|rebuild)$/.test(databaseName)) {
  throw new Error('Email read tests require a database ending in _test or _rebuild');
}

const prisma = new PrismaClient({ datasourceUrl: testDatabaseUrl });
let authenticatedUserId: string | undefined;
const authenticate: RequestHandler = (_request, response, next) => {
  if (authenticatedUserId) response.locals.principal = { userId: authenticatedUserId };
  next();
};

async function clearDatabase(): Promise<void> {
  await prisma.email.deleteMany();
  await prisma.slackIntegration.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.sender.deleteMany();
  await prisma.user.deleteMany();
}

async function fixture(label: string) {
  const user = await prisma.user.create({
    data: {
      googleSub: `google-${label}-${randomUUID()}`,
      email: `${label}@example.test`,
      name: `${label} User`,
    },
  });
  const sender = await prisma.sender.create({
    data: {
      userId: user.id,
      fromName: `${label} Sender`,
      fromEmail: `${label}@sender.test`,
    },
  });
  const campaign = await prisma.campaign.create({
    data: {
      userId: user.id,
      senderId: sender.id,
      subject: `${label} subject`,
      body: `${label} body with enough content for a useful preview`,
      startAt: new Date('2030-01-01T10:00:00.000Z'),
      delayMs: 2_000,
      hourlyLimit: 100,
      totalRecipients: 4,
      idempotencyKey: `key-${label}-${randomUUID()}`,
    },
  });
  return { user, sender, campaign };
}

async function createEmail(
  owner: Awaited<ReturnType<typeof fixture>>,
  input: {
    id?: string;
    status: EmailStatus;
    scheduledAt?: Date;
    updatedAt?: Date;
    recipient?: string;
  },
) {
  const id = input.id ?? randomUUID();
  return prisma.email.create({
    data: {
      id,
      campaignId: owner.campaign.id,
      userId: owner.user.id,
      senderId: owner.sender.id,
      recipientEmail: input.recipient ?? `${id}@recipient.test`,
      originalScheduledAt: input.scheduledAt ?? new Date('2030-01-01T10:01:00.000Z'),
      scheduledAt: input.scheduledAt ?? new Date('2030-01-01T10:01:00.000Z'),
      status: input.status,
      bullJobId: `email-${id}`,
      ...(input.status === EmailStatus.SENT
        ? { sentAt: new Date('2030-01-01T10:02:00.000Z') }
        : {}),
      ...(input.status === EmailStatus.FAILED ? { failureReason: 'Mailbox unavailable' } : {}),
      ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
    },
  });
}

function app() {
  return createApp({ prisma, authenticationMiddleware: authenticate });
}

beforeEach(async () => {
  await clearDatabase();
  authenticatedUserId = undefined;
});

afterAll(async () => {
  await clearDatabase();
  await prisma.$disconnect();
});

describe('sender and email read APIs', () => {
  it('requires authentication for every read route', async () => {
    await request(app()).get('/api/v1/senders').expect(401);
    await request(app()).get('/api/v1/emails/scheduled').expect(401);
    await request(app()).get('/api/v1/emails/sent').expect(401);
    await request(app()).get(`/api/v1/emails/${randomUUID()}`).expect(401);
  });

  it('returns only the current user active senders without secret fields', async () => {
    const owner = await fixture('owner');
    const other = await fixture('other');
    await prisma.sender.create({
      data: {
        userId: owner.user.id,
        fromName: 'Inactive',
        fromEmail: 'inactive@sender.test',
        active: false,
      },
    });
    authenticatedUserId = owner.user.id;

    const response = await request(app()).get('/api/v1/senders').expect(200);
    expect(response.body.items).toEqual([
      {
        id: owner.sender.id,
        fromName: owner.sender.fromName,
        fromEmail: owner.sender.fromEmail,
        active: true,
      },
    ]);
    expect(JSON.stringify(response.body)).not.toContain(other.sender.fromEmail);
    expect(Object.keys(response.body.items[0])).toEqual(['id', 'fromName', 'fromEmail', 'active']);
  });

  it('groups scheduled lifecycle states, reports totals, and excludes other tenants', async () => {
    const owner = await fixture('owner');
    const other = await fixture('other');
    await createEmail(owner, { status: EmailStatus.SCHEDULED });
    await createEmail(owner, { status: EmailStatus.PROCESSING });
    await createEmail(owner, { status: EmailStatus.SENT });
    await createEmail(other, { status: EmailStatus.SCHEDULED });
    authenticatedUserId = owner.user.id;

    const response = await request(app()).get('/api/v1/emails/scheduled').expect(200);
    expect(response.body.total).toBe(2);
    expect(response.body.items.map((item: { status: string }) => item.status).sort()).toEqual([
      'PROCESSING',
      'SCHEDULED',
    ]);
    expect(
      response.body.items.every((item: { subject: string }) => item.subject === 'owner subject'),
    ).toBe(true);
  });

  it('uses stable timestamp and ID cursor ordering without duplicates or omissions', async () => {
    const owner = await fixture('owner');
    const timestamp = new Date('2030-01-01T10:01:00.000Z');
    const ids = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
    ];
    for (const id of ids) {
      await createEmail(owner, { id, status: EmailStatus.SCHEDULED, scheduledAt: timestamp });
    }
    authenticatedUserId = owner.user.id;

    const first = await request(app()).get('/api/v1/emails/scheduled?limit=2').expect(200);
    expect(first.body.items.map((item: { id: string }) => item.id)).toEqual(ids.slice(0, 2));
    expect(first.body.total).toBe(3);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await request(app())
      .get(`/api/v1/emails/scheduled?limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`)
      .expect(200);
    expect(second.body.items.map((item: { id: string }) => item.id)).toEqual(ids.slice(2));
    expect(second.body.nextCursor).toBeNull();
  });

  it('returns SENT and FAILED terminal history with nullable sent time', async () => {
    const owner = await fixture('owner');
    const tied = new Date('2030-01-01T11:00:00.000Z');
    const sent = await createEmail(owner, {
      id: '00000000-0000-4000-8000-000000000010',
      status: EmailStatus.SENT,
      updatedAt: tied,
    });
    const failed = await createEmail(owner, {
      id: '00000000-0000-4000-8000-000000000011',
      status: EmailStatus.FAILED,
      updatedAt: tied,
    });
    await createEmail(owner, { status: EmailStatus.PROCESSING });
    authenticatedUserId = owner.user.id;

    const response = await request(app()).get('/api/v1/emails/sent').expect(200);
    expect(response.body.total).toBe(2);
    expect(response.body.items.map((item: { id: string }) => item.id)).toEqual([
      failed.id,
      sent.id,
    ]);
    expect(response.body.items[0]).toMatchObject({
      status: 'FAILED',
      sentAt: null,
      failureReason: 'Mailbox unavailable',
    });
    expect(response.body.items[1].sentAt).toEqual(expect.any(String));
  });

  it('validates pagination and scopes detail reads to the owner', async () => {
    const owner = await fixture('owner');
    const other = await fixture('other');
    const email = await createEmail(owner, { status: EmailStatus.SCHEDULED });
    authenticatedUserId = owner.user.id;

    await request(app()).get('/api/v1/emails/scheduled?limit=101').expect(400);
    await request(app()).get('/api/v1/emails/scheduled?cursor=not-a-cursor').expect(400);
    await request(app()).get('/api/v1/emails/not-a-uuid').expect(400);

    const detail = await request(app()).get(`/api/v1/emails/${email.id}`).expect(200);
    expect(detail.body).toMatchObject({
      id: email.id,
      recipientEmail: email.recipientEmail,
      subject: 'owner subject',
      body: 'owner body with enough content for a useful preview',
      sender: { id: owner.sender.id, fromEmail: owner.sender.fromEmail },
    });

    authenticatedUserId = other.user.id;
    await request(app()).get(`/api/v1/emails/${email.id}`).expect(404);
  });
});
