import { describe, expect, it } from 'vitest';

import { getEffectiveSendLimits } from './effective-limits.js';
import { getUtcHourWindow } from './utc-hour.js';

describe('UTC hour windows', () => {
  it('returns canonical boundaries within an hour', () => {
    expect(getUtcHourWindow(new Date('2030-01-01T14:34:56.789Z'))).toEqual({
      id: '2030-01-01T14',
      startAt: new Date('2030-01-01T14:00:00.000Z'),
      nextAt: new Date('2030-01-01T15:00:00.000Z'),
    });
  });

  it('moves to the next window at the exact UTC boundary', () => {
    expect(getUtcHourWindow(new Date('2030-01-01T15:00:00.000Z')).id).toBe('2030-01-01T15');
  });
});

describe('effective send limits', () => {
  it('uses the stricter platform delay and campaign hourly cap', () => {
    expect(
      getEffectiveSendLimits(
        { delayMs: 500, hourlyLimit: 20 },
        { minSendDelayMs: 2_000, maxEmailsPerHourPerSender: 100 },
      ),
    ).toEqual({ delayMs: 2_000, hourlyLimit: 20 });
  });

  it('uses the stricter campaign delay and platform hourly cap', () => {
    expect(
      getEffectiveSendLimits(
        { delayMs: 5_000, hourlyLimit: 500 },
        { minSendDelayMs: 2_000, maxEmailsPerHourPerSender: 200 },
      ),
    ).toEqual({ delayMs: 5_000, hourlyLimit: 200 });
  });
});
