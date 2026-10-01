import { Redis } from 'ioredis';

import { senderNextSendKey, senderRateCounterKey } from './keys.js';
import { getUtcHourWindow } from './utc-hour.js';

const PERMIT_SCRIPT = `
local nowMs = tonumber(ARGV[1])
local delayMs = tonumber(ARGV[2])
local hourlyLimit = tonumber(ARGV[3])
local nextHourMs = tonumber(ARGV[4])

local count = tonumber(redis.call('GET', KEYS[1]) or '0')
local nextAllowedAt = tonumber(redis.call('GET', KEYS[2]) or '0')

if count >= hourlyLimit then
  return {0, 2, nextHourMs, count}
end

if nowMs < nextAllowedAt then
  return {0, 1, nextAllowedAt, count}
end

local reservedCount = redis.call('INCR', KEYS[1])
if reservedCount == 1 then
  redis.call('PEXPIREAT', KEYS[1], nextHourMs + 3600000)
end

local reservedNextAllowedAt = nowMs + delayMs
redis.call('SET', KEYS[2], reservedNextAllowedAt, 'PX', delayMs + 3600000)

local reached = 0
if reservedCount == hourlyLimit then
  reached = 1
end

return {1, reservedCount, reached, reservedNextAllowedAt}
`;

export interface SendPermitInput {
  senderId: string;
  now: Date;
  delayMs: number;
  hourlyLimit: number;
}

export type SendPermitDecision =
  | {
      allowed: true;
      count: number;
      limitReachedThisReservation: boolean;
      hourWindow: string;
      nextAllowedAt: Date;
    }
  | {
      allowed: false;
      reason: 'MIN_DELAY' | 'HOURLY_LIMIT';
      retryAt: Date;
      count: number;
      hourWindow: string;
    };

export interface SendPermitGate {
  acquire(input: SendPermitInput): Promise<SendPermitDecision>;
}

export function createLimiterRedisClient(redisUrl: string): Redis {
  return new Redis(redisUrl, {
    connectTimeout: 10_000,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt: number) => Math.min(attempt * 500, 5_000),
  });
}

export class RedisSendPermitGate implements SendPermitGate {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  async acquire({
    senderId,
    now,
    delayMs,
    hourlyLimit,
  }: SendPermitInput): Promise<SendPermitDecision> {
    const window = getUtcHourWindow(now);
    const raw = await this.#redis.eval(
      PERMIT_SCRIPT,
      2,
      senderRateCounterKey(senderId, window.id),
      senderNextSendKey(senderId),
      now.getTime(),
      delayMs,
      hourlyLimit,
      window.nextAt.getTime(),
    );
    const values = parseScriptResponse(raw);

    if (values[0] === 1) {
      return {
        allowed: true,
        count: values[1],
        limitReachedThisReservation: values[2] === 1,
        hourWindow: window.id,
        nextAllowedAt: new Date(values[3]),
      };
    }

    return {
      allowed: false,
      reason: values[1] === 1 ? 'MIN_DELAY' : 'HOURLY_LIMIT',
      retryAt: new Date(values[2]),
      count: values[3],
      hourWindow: window.id,
    };
  }
}

function parseScriptResponse(value: unknown): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error('Redis send-permit script returned an invalid response');
  }

  const numbers = value.map((entry) => Number(entry));
  if (numbers.some((entry) => !Number.isFinite(entry))) {
    throw new Error('Redis send-permit script returned non-numeric values');
  }

  return numbers as [number, number, number, number];
}
