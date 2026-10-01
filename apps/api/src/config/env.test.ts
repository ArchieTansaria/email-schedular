import { describe, expect, it } from 'vitest';

import { parseApiConfig } from './env.js';

const baseEnvironment = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/reachinbox_test',
  REDIS_URL: 'redis://localhost:6379',
  ELASTICSEARCH_URL: 'http://localhost:9200',
  SESSION_SECRET: 'test-session-secret-that-is-at-least-32-characters',
  APP_ENCRYPTION_KEY: 'test-encryption-key-that-is-at-least-32-characters',
  WORKER_CONCURRENCY: '10',
  MIN_SEND_DELAY_MS: '2000',
  MAX_EMAILS_PER_HOUR_PER_SENDER: '200',
};

describe('API environment configuration', () => {
  it('accepts a complete Google OAuth configuration', () => {
    expect(
      parseApiConfig({
        ...baseEnvironment,
        GOOGLE_CLIENT_ID: 'google-client-id',
        GOOGLE_CLIENT_SECRET: 'google-client-secret',
        GOOGLE_CALLBACK_URL: 'http://localhost:4000/api/v1/auth/google/callback',
      }),
    ).toMatchObject({
      HOST: '0.0.0.0',
      GOOGLE_CLIENT_ID: 'google-client-id',
      GOOGLE_CALLBACK_URL: 'http://localhost:4000/api/v1/auth/google/callback',
    });
  });

  it('rejects partially configured Google OAuth', () => {
    expect(() =>
      parseApiConfig({ ...baseEnvironment, GOOGLE_CLIENT_ID: 'google-client-id' }),
    ).toThrow(/Google OAuth configuration must be either complete or entirely omitted/);
  });
});
