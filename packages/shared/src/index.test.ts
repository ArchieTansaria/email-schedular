import { describe, expect, it } from 'vitest';

import {
  EnvironmentValidationError,
  SERVICE_NAME,
  createHealthResponse,
  getRedisConnectionSettings,
  parseRuntimeEnv,
} from './index.js';

const validEnvironment = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/reachinbox_test',
  REDIS_URL: 'redis://localhost:6379',
  ELASTICSEARCH_URL: 'http://localhost:9200',
  SESSION_SECRET: 'test-session-secret-at-least-32-characters',
  APP_ENCRYPTION_KEY: 'test-encryption-key-at-least-32-chars',
  WORKER_CONCURRENCY: '10',
  MIN_SEND_DELAY_MS: '2000',
  MAX_EMAILS_PER_HOUR_PER_SENDER: '200',
} as const;

describe('shared package', () => {
  it('exports a portable health contract', () => {
    expect(createHealthResponse()).toEqual({ status: 'ok', service: SERVICE_NAME });
  });

  it('parses valid configuration into typed values', () => {
    const config = parseRuntimeEnv(validEnvironment);

    expect(config.WORKER_CONCURRENCY).toBe(10);
    expect(config.MIN_SEND_DELAY_MS).toBe(2000);
    expect(config.GOOGLE_CLIENT_ID).toBeUndefined();
  });

  it('fails clearly when required configuration is missing', () => {
    const missingDatabaseUrl = { ...validEnvironment, DATABASE_URL: undefined };

    expect(() => parseRuntimeEnv(missingDatabaseUrl)).toThrow(EnvironmentValidationError);
    expect(() => parseRuntimeEnv(missingDatabaseUrl)).toThrow(/DATABASE_URL/);
  });

  it.each([
    ['WORKER_CONCURRENCY', 'not-a-number'],
    ['MIN_SEND_DELAY_MS', '1.5'],
    ['MAX_EMAILS_PER_HOUR_PER_SENDER', '0'],
  ])('rejects invalid numeric configuration for %s', (key, value) => {
    expect(() => parseRuntimeEnv({ ...validEnvironment, [key]: value })).toThrow(key);
  });

  it.each(['0', '-1', '101', '2.5'])('rejects invalid WORKER_CONCURRENCY=%s', (value) => {
    expect(() => parseRuntimeEnv({ ...validEnvironment, WORKER_CONCURRENCY: value })).toThrow(
      /WORKER_CONCURRENCY/,
    );
  });

  it('exposes BullMQ-compatible Redis connection settings', () => {
    const config = parseRuntimeEnv(validEnvironment);

    expect(getRedisConnectionSettings(config)).toEqual({
      url: 'redis://localhost:6379',
      maxRetriesPerRequest: null,
    });
  });
});
