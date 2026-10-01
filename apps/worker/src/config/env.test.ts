import { describe, expect, it } from 'vitest';

import { parseWorkerConfig } from './env.js';

const validEnvironment = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/reachinbox_test',
  REDIS_URL: 'redis://localhost:6379',
  ELASTICSEARCH_URL: 'http://localhost:9200',
  SESSION_SECRET: 'test-session-secret-that-is-long-enough',
  APP_ENCRYPTION_KEY: 'test-encryption-key-that-is-long-enough',
  WORKER_CONCURRENCY: '3',
  MIN_SEND_DELAY_MS: '2000',
  MAX_EMAILS_PER_HOUR_PER_SENDER: '200',
  ETHEREAL_SENDER_1_USER: 'sender-a@ethereal.email',
  ETHEREAL_SENDER_1_PASS: 'secret-a',
  ETHEREAL_SENDER_2_USER: 'sender-b@ethereal.email',
  ETHEREAL_SENDER_2_PASS: 'secret-b',
};

describe('parseWorkerConfig', () => {
  it('requires and parses two Ethereal accounts separately from shared runtime config', () => {
    expect(parseWorkerConfig(validEnvironment)).toMatchObject({
      WORKER_CONCURRENCY: 3,
      MIN_SEND_DELAY_MS: 2_000,
      MAX_EMAILS_PER_HOUR_PER_SENDER: 200,
      ETHEREAL_SENDER_1_USER: 'sender-a@ethereal.email',
      ETHEREAL_SENDER_2_USER: 'sender-b@ethereal.email',
    });
  });

  it.each([
    'ETHEREAL_SENDER_1_USER',
    'ETHEREAL_SENDER_1_PASS',
    'ETHEREAL_SENDER_2_USER',
    'ETHEREAL_SENDER_2_PASS',
  ] as const)('rejects missing Worker delivery configuration: %s', (field) => {
    expect(() => parseWorkerConfig({ ...validEnvironment, [field]: '' })).toThrow();
  });

  it('rejects duplicate Ethereal account identities', () => {
    expect(() =>
      parseWorkerConfig({
        ...validEnvironment,
        ETHEREAL_SENDER_2_USER: 'SENDER-A@ETHEREAL.EMAIL',
      }),
    ).toThrow(/Ethereal sender accounts must be different/);
  });

  it.each(['MIN_SEND_DELAY_MS', 'MAX_EMAILS_PER_HOUR_PER_SENDER'] as const)(
    'rejects a non-positive runtime limit: %s',
    (field) => {
      expect(() => parseWorkerConfig({ ...validEnvironment, [field]: '0' })).toThrow();
    },
  );
});
