import { randomUUID } from 'node:crypto';

import { EmailStatus } from '@prisma/client';
import {
  createElasticsearchClient,
  EmailSearchService,
  parseSearchConfig,
  type EmailSearchDocument,
} from '@reachinbox/search';
import type { RequestHandler } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../../app.js';

const client = createElasticsearchClient(parseSearchConfig(process.env));
const indexName = `reachinbox-test-api-search-${randomUUID()}`.toLowerCase();
const search = new EmailSearchService({ client, prisma: {} as never, indexName });
const authenticate: RequestHandler = (_request, response, next) => {
  response.locals.principal = { userId: 'user-a' };
  next();
};
const logger = { error: vi.fn() };

describe('GET /api/v1/emails/search', () => {
  beforeAll(async () => {
    await search.ensureIndex();
    await search.bulkIndexDocuments(
      [
        document('a1', { userId: 'user-a', subject: 'Apollo backend hiring' }),
        document('a2', { userId: 'user-a', body: 'backend systems', status: EmailStatus.SENT }),
        document('b1', { userId: 'user-b', subject: 'Apollo backend private' }),
      ],
      { refresh: 'wait_for' },
    );
  });

  afterAll(async () => {
    await client.indices.delete({ index: indexName, ignore_unavailable: true });
    await client.close();
  });

  it('requires authentication', async () => {
    const response = await request(createApp({ emailSearch: search, logger })).get(
      '/api/v1/emails/search?q=backend',
    );
    expect(response.status).toBe(401);
  });

  it('returns only the authenticated owner records and supports status and pagination', async () => {
    const app = createApp({ emailSearch: search, authenticationMiddleware: authenticate, logger });
    const response = await request(app).get('/api/v1/emails/search?q=backend&limit=1&page=2');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ total: 2, page: 2, limit: 1 });
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].userId).toBe('user-a');

    const sent = await request(app).get('/api/v1/emails/search?q=backend&status=SENT');
    expect(sent.status).toBe(200);
    expect(sent.body.items).toHaveLength(1);
    expect(sent.body.items[0]).toMatchObject({ emailId: 'a2', status: 'SENT' });
  });

  it('returns clean empty results and rejects malformed pagination/status values', async () => {
    const app = createApp({ emailSearch: search, authenticationMiddleware: authenticate, logger });
    const empty = await request(app).get('/api/v1/emails/search?q=does-not-exist');
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ items: [], total: 0 });
    for (const query of ['', '?q=x&limit=101', '?q=x&page=0', '?q=x&status=UNKNOWN']) {
      expect((await request(app).get(`/api/v1/emails/search${query}`)).status).toBe(400);
    }
  });

  it('maps Elasticsearch failures to a sanitized 503', async () => {
    const app = createApp({
      emailSearch: { search: vi.fn().mockRejectedValue(new Error('connection details')) },
      authenticationMiddleware: authenticate,
      logger,
    });
    const response = await request(app).get('/api/v1/emails/search?q=backend');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: { code: 'SEARCH_UNAVAILABLE', message: 'Email search is temporarily unavailable' },
    });
    expect(JSON.stringify(response.body)).not.toContain('connection details');
  });
});

function document(id: string, overrides: Partial<EmailSearchDocument>): EmailSearchDocument {
  return {
    emailId: id,
    campaignId: 'campaign',
    userId: 'user-a',
    senderId: 'sender',
    recipientEmail: `${id}@recipient.test`,
    senderEmail: 'sender@example.test',
    subject: 'General hiring',
    body: 'General body',
    status: EmailStatus.SCHEDULED,
    originalScheduledAt: '2030-01-01T00:00:00.000Z',
    scheduledAt: '2030-01-01T00:00:00.000Z',
    sentAt: null,
    failureReason: null,
    ...overrides,
  };
}
