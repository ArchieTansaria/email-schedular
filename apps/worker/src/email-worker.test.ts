import { describe, expect, it } from 'vitest';

import { createWorkerConnectionOptions } from './email-worker.js';

describe('Email Worker configuration', () => {
  it('uses retry-forever Worker connection semantics', () => {
    const options = createWorkerConnectionOptions('redis://localhost:6379');

    expect(options).toMatchObject({
      url: 'redis://localhost:6379',
      maxRetriesPerRequest: null,
    });
    expect('retryStrategy' in options && options.retryStrategy?.(20)).toBe(5_000);
  });
});
