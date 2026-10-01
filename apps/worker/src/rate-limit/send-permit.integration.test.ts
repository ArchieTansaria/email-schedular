import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import {
  createLimiterRedisClient,
  RedisSendPermitGate,
  type SendPermitDecision,
} from './send-permit.js';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const redis = createLimiterRedisClient(redisUrl);
const gate = new RedisSendPermitGate(redis);

afterAll(() => redis.quit());

function allowed(decision: SendPermitDecision) {
  expect(decision.allowed).toBe(true);
  if (!decision.allowed) throw new Error(`Expected permit, received ${decision.reason}`);
  return decision;
}

describe('Redis sender permit', () => {
  it('allows the first permit, enforces spacing, then allows at the boundary', async () => {
    const senderId = randomUUID();
    const now = new Date('2030-01-01T14:00:00.000Z');
    const first = allowed(await gate.acquire({ senderId, now, delayMs: 2_000, hourlyLimit: 10 }));
    expect(first.count).toBe(1);
    expect(first.limitReachedThisReservation).toBe(false);

    const blocked = await gate.acquire({ senderId, now, delayMs: 2_000, hourlyLimit: 10 });
    expect(blocked).toEqual({
      allowed: false,
      reason: 'MIN_DELAY',
      retryAt: new Date('2030-01-01T14:00:02.000Z'),
      count: 1,
      hourWindow: '2030-01-01T14',
    });

    const second = allowed(
      await gate.acquire({
        senderId,
        now: new Date('2030-01-01T14:00:02.000Z'),
        delayMs: 2_000,
        hourlyLimit: 10,
      }),
    );
    expect(second.count).toBe(2);
  });

  it('signals the final allowed reservation and blocks overflow until the next UTC hour', async () => {
    const senderId = randomUUID();
    const now = new Date('2030-01-01T14:10:00.000Z');

    for (let count = 1; count <= 3; count += 1) {
      const decision = allowed(await gate.acquire({ senderId, now, delayMs: 0, hourlyLimit: 3 }));
      expect(decision.count).toBe(count);
      expect(decision.limitReachedThisReservation).toBe(count === 3);
    }

    await expect(gate.acquire({ senderId, now, delayMs: 0, hourlyLimit: 3 })).resolves.toEqual({
      allowed: false,
      reason: 'HOURLY_LIMIT',
      retryAt: new Date('2030-01-01T15:00:00.000Z'),
      count: 3,
      hourWindow: '2030-01-01T14',
    });
  });

  it('starts a fresh counter at a fixed UTC-hour rollover', async () => {
    const senderId = randomUUID();
    allowed(
      await gate.acquire({
        senderId,
        now: new Date('2030-01-01T14:59:59.999Z'),
        delayMs: 0,
        hourlyLimit: 1,
      }),
    );

    const nextWindow = allowed(
      await gate.acquire({
        senderId,
        now: new Date('2030-01-01T15:00:00.000Z'),
        delayMs: 0,
        hourlyLimit: 1,
      }),
    );
    expect(nextWindow).toMatchObject({ count: 1, hourWindow: '2030-01-01T15' });
  });

  it('keeps different senders independent', async () => {
    const now = new Date('2030-01-01T14:00:00.000Z');
    const senderA = randomUUID();
    const senderB = randomUUID();
    allowed(await gate.acquire({ senderId: senderA, now, delayMs: 0, hourlyLimit: 1 }));

    const blockedA = await gate.acquire({ senderId: senderA, now, delayMs: 0, hourlyLimit: 1 });
    const allowedB = allowed(
      await gate.acquire({ senderId: senderB, now, delayMs: 0, hourlyLimit: 1 }),
    );
    expect(blockedA).toMatchObject({ allowed: false, reason: 'HOURLY_LIMIT' });
    expect(allowedB.count).toBe(1);
  });

  it('atomically grants at most five of twenty simultaneous requests across clients', async () => {
    const senderId = randomUUID();
    const now = new Date('2030-01-01T14:00:00.000Z');
    const clients = Array.from({ length: 4 }, () => createLimiterRedisClient(redisUrl));
    const gates = clients.map((client) => new RedisSendPermitGate(client));

    try {
      const decisions = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          gates[index % gates.length]!.acquire({
            senderId,
            now,
            delayMs: 0,
            hourlyLimit: 5,
          }),
        ),
      );
      expect(decisions.filter((decision) => decision.allowed)).toHaveLength(5);
      expect(
        decisions.filter((decision) => !decision.allowed && decision.reason === 'HOURLY_LIMIT'),
      ).toHaveLength(15);
    } finally {
      await Promise.all(clients.map((client) => client.quit()));
    }
  });
});
