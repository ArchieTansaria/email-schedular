import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

describe('GET /api/health', () => {
  it('returns a successful JSON health response without opening a port', async () => {
    const response = await request(createApp()).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toEqual({
      status: 'ok',
      service: 'reachinbox-scheduler',
    });
  });
});
