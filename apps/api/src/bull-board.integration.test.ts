import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import { EmailQueueProducer } from './queue/email-queue.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const logger = { error: vi.fn() };
const producer = new EmailQueueProducer({
  redisUrl,
  logger,
  prefix: `reachinbox-board-test-${randomUUID()}`,
});

beforeAll(() => producer.waitUntilReady());

afterAll(async () => {
  await producer.queue.obliterate({ force: true });
  await producer.close();
});

describe('Bull Board', () => {
  it('serves the queue dashboard from the API', async () => {
    const app = createApp({ emailQueue: producer.queue });
    const response = await request(app).get('/admin/queues/');
    const queuesResponse = await request(app).get('/admin/queues/api/queues');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.text).toContain('Bull Dashboard');
    expect(queuesResponse.status).toBe(200);
    expect(queuesResponse.body.queues).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'email-send' })]),
    );
  });
});
