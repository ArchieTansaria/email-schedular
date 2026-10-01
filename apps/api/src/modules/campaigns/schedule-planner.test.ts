import { describe, expect, it } from 'vitest';

import { planSchedule } from './schedule-planner.js';

function iso(values: readonly Date[]): string[] {
  return values.map((value) => value.toISOString());
}

describe('planSchedule', () => {
  it('spaces recipients by at least the requested delay', () => {
    const planned = planSchedule({
      recipientCount: 5,
      startAt: new Date('2030-01-01T10:00:00.000Z'),
      now: new Date('2030-01-01T09:00:00.000Z'),
      delayMs: 2_000,
      hourlyLimit: 100,
    });

    expect(iso(planned)).toEqual([
      '2030-01-01T10:00:00.000Z',
      '2030-01-01T10:00:02.000Z',
      '2030-01-01T10:00:04.000Z',
      '2030-01-01T10:00:06.000Z',
      '2030-01-01T10:00:08.000Z',
    ]);
  });

  it('moves excess recipients to the next fixed UTC hour', () => {
    const planned = planSchedule({
      recipientCount: 4,
      startAt: new Date('2030-01-01T10:00:00.000Z'),
      now: new Date('2030-01-01T09:00:00.000Z'),
      delayMs: 2_000,
      hourlyLimit: 2,
    });

    expect(iso(planned)).toEqual([
      '2030-01-01T10:00:00.000Z',
      '2030-01-01T10:00:02.000Z',
      '2030-01-01T11:00:00.000Z',
      '2030-01-01T11:00:02.000Z',
    ]);
  });

  it('resets the window count when delay naturally crosses an hour', () => {
    const planned = planSchedule({
      recipientCount: 3,
      startAt: new Date('2030-01-01T10:40:00.000Z'),
      now: new Date('2030-01-01T09:00:00.000Z'),
      delayMs: 30 * 60 * 1_000,
      hourlyLimit: 1,
    });

    expect(iso(planned)).toEqual([
      '2030-01-01T10:40:00.000Z',
      '2030-01-01T11:10:00.000Z',
      '2030-01-01T12:00:00.000Z',
    ]);
  });

  it('clamps a past start time to the injected current time', () => {
    const now = new Date('2030-01-01T10:15:00.000Z');

    expect(
      planSchedule({
        recipientCount: 1,
        startAt: new Date('2030-01-01T09:00:00.000Z'),
        now,
        delayMs: 2_000,
        hourlyLimit: 10,
      }),
    ).toEqual([now]);
  });

  it('handles an exact UTC hour boundary caused by normal spacing', () => {
    const planned = planSchedule({
      recipientCount: 2,
      startAt: new Date('2030-01-01T10:59:58.000Z'),
      now: new Date('2030-01-01T09:00:00.000Z'),
      delayMs: 2_000,
      hourlyLimit: 1,
    });

    expect(iso(planned)).toEqual(['2030-01-01T10:59:58.000Z', '2030-01-01T11:00:00.000Z']);
  });

  it('plans one recipient', () => {
    expect(
      planSchedule({
        recipientCount: 1,
        startAt: new Date('2030-01-01T10:00:00.000Z'),
        now: new Date('2030-01-01T09:00:00.000Z'),
        delayMs: 2_000,
        hourlyLimit: 1,
      }),
    ).toEqual([new Date('2030-01-01T10:00:00.000Z')]);
  });

  it('plans 1,000 ordered timestamps while respecting every UTC hourly limit', () => {
    const hourlyLimit = 200;
    const planned = planSchedule({
      recipientCount: 1_000,
      startAt: new Date('2030-01-01T10:00:00.000Z'),
      now: new Date('2030-01-01T09:00:00.000Z'),
      delayMs: 2_000,
      hourlyLimit,
    });
    const counts = new Map<string, number>();

    for (const [index, timestamp] of planned.entries()) {
      const hour = timestamp.toISOString().slice(0, 13);
      counts.set(hour, (counts.get(hour) ?? 0) + 1);
      if (index > 0) {
        expect(timestamp.getTime() - (planned[index - 1]?.getTime() ?? 0)).toBeGreaterThanOrEqual(
          2_000,
        );
      }
    }

    expect(planned).toHaveLength(1_000);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(hourlyLimit);
    expect(planned.at(-1)).toEqual(new Date('2030-01-01T14:06:38.000Z'));
  });
});
