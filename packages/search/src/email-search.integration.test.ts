import { randomUUID } from 'node:crypto';

import { PrismaClient, EmailStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createElasticsearchClient, parseSearchConfig } from './config.js';
import type { EmailSearchDocument } from './document.js';
import { EmailSearchService } from './email-search.js';
import { reindexEmails } from './reindex.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('TEST_DATABASE_URL is required');

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const client = createElasticsearchClient(parseSearchConfig(process.env));
const indexName = `reachinbox-test-emails-${randomUUID()}`.toLowerCase();
const search = new EmailSearchService({ client, prisma, indexName });

describe('Elasticsearch email projection', () => {
  beforeAll(async () => {
    await prisma.$connect();
    await search.ensureIndex();
  });

  afterAll(async () => {
    await client.indices.delete({ index: indexName, ignore_unavailable: true });
    await prisma.email.deleteMany();
    await prisma.campaign.deleteMany();
    await prisma.sender.deleteMany();
    await prisma.user.deleteMany();
    await Promise.all([client.close(), prisma.$disconnect()]);
  });

  it('creates the explicit mapping idempotently', async () => {
    await expect(search.ensureIndex()).resolves.toBe('existing');
    const mapping = await client.indices.getMapping({ index: indexName });
    const properties = mapping[indexName]?.mappings.properties;
    expect(properties?.emailId).toMatchObject({ type: 'keyword' });
    expect(properties?.subject).toMatchObject({ type: 'text' });
    expect(properties?.status).toMatchObject({ type: 'keyword' });
    expect(properties?.scheduledAt).toMatchObject({ type: 'date' });
  });

  it('bulk indexes 1,000 deterministic documents without duplicates', async () => {
    const documents = Array.from({ length: 1_000 }, (_, index) => documentFor(index));
    await expect(search.bulkIndexDocuments(documents, { refresh: 'wait_for' })).resolves.toEqual({
      indexed: 1_000,
      failures: [],
    });
    await search.bulkIndexDocuments(documents, { refresh: 'wait_for' });
    const count = await client.count({ index: indexName });
    expect(count.count).toBe(1_000);
  });

  it('searches text and recipient fields while enforcing owner and status filters', async () => {
    await client.indices.delete({ index: indexName });
    await search.ensureIndex();
    await search.bulkIndexDocuments(
      [
        documentFor(1, {
          userId: 'user-a',
          subject: 'Apollo backend hiring',
          status: EmailStatus.SCHEDULED,
        }),
        documentFor(2, {
          userId: 'user-b',
          subject: 'Apollo backend secret',
          status: EmailStatus.SENT,
        }),
        documentFor(3, {
          userId: 'user-a',
          body: 'Frontend position',
          recipientEmail: 'person@example.com',
          status: EmailStatus.SENT,
        }),
      ],
      { refresh: 'wait_for' },
    );

    const subject = await search.search({ userId: 'user-a', q: 'backend', page: 1, limit: 20 });
    expect(subject.items.map((item) => item.emailId)).toEqual([
      '00000000-0000-4000-8000-000000000001',
    ]);
    const recipient = await search.search({
      userId: 'user-a',
      q: 'person@example.com',
      status: EmailStatus.SENT,
      page: 1,
      limit: 20,
    });
    expect(recipient.total).toBe(1);
    expect(recipient.items[0]?.recipientEmail).toBe('person@example.com');
  });

  it('builds scheduled documents from normalized PostgreSQL Campaign and Sender data', async () => {
    await prisma.email.deleteMany();
    await prisma.campaign.deleteMany();
    await prisma.sender.deleteMany();
    await prisma.user.deleteMany();
    const user = await prisma.user.create({
      data: {
        googleSub: `scheduled-${randomUUID()}`,
        email: 'scheduled@example.test',
        name: 'Scheduled',
      },
    });
    const sender = await prisma.sender.create({
      data: { userId: user.id, fromName: 'Sender', fromEmail: 'scheduled-sender@example.test' },
    });
    const campaign = await prisma.campaign.create({
      data: {
        userId: user.id,
        senderId: sender.id,
        subject: 'Scheduled Apollo backend',
        body: 'Campaign body',
        startAt: new Date('2030-01-01T00:00:00Z'),
        delayMs: 2000,
        hourlyLimit: 100,
        totalRecipients: 1,
        idempotencyKey: randomUUID(),
      },
    });
    const email = await prisma.email.create({
      data: {
        userId: user.id,
        senderId: sender.id,
        campaignId: campaign.id,
        recipientEmail: 'lead@example.test',
        originalScheduledAt: campaign.startAt,
        scheduledAt: campaign.startAt,
        bullJobId: `email-${randomUUID()}`,
      },
    });

    await search.indexCampaign(campaign.id);
    await client.indices.refresh({ index: indexName });

    const result = await search.search({ userId: user.id, q: 'Apollo', page: 1, limit: 20 });
    expect(result.items[0]).toMatchObject({
      emailId: email.id,
      senderEmail: sender.fromEmail,
      subject: campaign.subject,
      status: 'SCHEDULED',
    });
  });

  it('rebuilds a deleted index from PostgreSQL in bounded, idempotent batches', async () => {
    await prisma.email.deleteMany();
    await prisma.campaign.deleteMany();
    await prisma.sender.deleteMany();
    await prisma.user.deleteMany();
    const user = await prisma.user.create({
      data: { googleSub: `g-${randomUUID()}`, email: 'owner@example.test', name: 'Owner' },
    });
    const sender = await prisma.sender.create({
      data: { userId: user.id, fromName: 'Sender', fromEmail: 'sender@example.test' },
    });
    const campaign = await prisma.campaign.create({
      data: {
        userId: user.id,
        senderId: sender.id,
        subject: 'Rebuild me',
        body: 'Postgres wins',
        startAt: new Date('2030-01-01T00:00:00Z'),
        delayMs: 2000,
        hourlyLimit: 100,
        totalRecipients: 4,
        idempotencyKey: randomUUID(),
      },
    });
    for (const [index, status] of [
      EmailStatus.SCHEDULED,
      EmailStatus.PROCESSING,
      EmailStatus.SENT,
      EmailStatus.FAILED,
    ].entries()) {
      await prisma.email.create({
        data: {
          userId: user.id,
          senderId: sender.id,
          campaignId: campaign.id,
          recipientEmail: `rebuild-${index}@example.test`,
          originalScheduledAt: new Date(`2030-01-01T00:00:0${index}Z`),
          scheduledAt: new Date(`2030-01-01T00:00:0${index}Z`),
          status,
          bullJobId: `email-${randomUUID()}`,
          ...(status === EmailStatus.SENT ? { sentAt: new Date('2030-01-01T00:01:00Z') } : {}),
          ...(status === EmailStatus.FAILED ? { failureReason: 'Rejected' } : {}),
        },
      });
    }

    await client.indices.delete({ index: indexName });
    const first = await reindexEmails({ prisma, search, batchSize: 2, refresh: 'wait_for' });
    const second = await reindexEmails({ prisma, search, batchSize: 2, refresh: 'wait_for' });
    expect(first).toEqual({ rowsRead: 4, indexed: 4, failures: 0 });
    expect(second).toEqual(first);
    expect((await client.count({ index: indexName })).count).toBe(4);
    const failed = await search.search({
      userId: user.id,
      q: 'Rebuild',
      status: EmailStatus.FAILED,
      page: 1,
      limit: 20,
    });
    expect(failed.items[0]).toMatchObject({ status: 'FAILED', failureReason: 'Rejected' });
  });
});

function documentFor(
  index: number,
  overrides: Partial<EmailSearchDocument> = {},
): EmailSearchDocument {
  const suffix = String(index).padStart(12, '0');
  return {
    emailId: `00000000-0000-4000-8000-${suffix}`,
    campaignId: '00000000-0000-4000-8000-100000000000',
    userId: 'user-a',
    senderId: '00000000-0000-4000-8000-200000000000',
    recipientEmail: `recipient-${index}@example.com`,
    senderEmail: 'sender@example.com',
    subject: `Campaign ${index}`,
    body: 'Searchable email body',
    status: EmailStatus.SCHEDULED,
    originalScheduledAt: '2030-01-01T00:00:00.000Z',
    scheduledAt: '2030-01-01T00:00:00.000Z',
    sentAt: null,
    failureReason: null,
    ...overrides,
  };
}
