import { describe, expect, it } from 'vitest';

import { calculateJobDelay, createProducerConnectionOptions } from './email-queue.js';

describe('email queue producer policy', () => {
  const now = new Date('2030-01-01T10:00:00.000Z');

  it('calculates a positive delay for a future schedule', () => {
    expect(calculateJobDelay(new Date('2030-01-01T10:00:05.000Z'), now)).toBe(5_000);
  });

  it('uses zero delay when the schedule equals now', () => {
    expect(calculateJobDelay(now, now)).toBe(0);
  });

  it('clamps a past schedule to zero delay', () => {
    expect(calculateJobDelay(new Date('2030-01-01T09:59:55.000Z'), now)).toBe(0);
  });

  it('bounds API producer command retries while allowing background reconnection', () => {
    expect(createProducerConnectionOptions('redis://localhost:6379')).toMatchObject({
      url: 'redis://localhost:6379',
      connectTimeout: 3_000,
      maxRetriesPerRequest: 1,
    });
  });
});
