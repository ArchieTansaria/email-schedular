import { randomUUID } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';

import type { SlackClient } from './client.js';
import type { SecretCipher } from './encryption.js';

const RELEASE_CLAIM_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export interface RateLimitAlertInput {
  userId: string;
  senderId: string;
  senderEmail: string;
  hourWindow: string;
  hourlyLimit: number;
  limitReachedThisReservation: boolean;
}

export type RateLimitAlertOutcome = 'not-reached' | 'not-connected' | 'duplicate' | 'sent';

export interface RateLimitNotifier {
  notify(input: RateLimitAlertInput): Promise<RateLimitAlertOutcome>;
}

export class SlackRateLimitNotifier implements RateLimitNotifier {
  readonly #prisma: PrismaClient;
  readonly #redis: Pick<Redis, 'set' | 'eval'>;
  readonly #cipher: SecretCipher;
  readonly #client: Pick<SlackClient, 'postWebhook'>;
  readonly #prefix: string;

  constructor(options: {
    prisma: PrismaClient;
    redis: Pick<Redis, 'set' | 'eval'>;
    cipher: SecretCipher;
    client: Pick<SlackClient, 'postWebhook'>;
    prefix?: string;
  }) {
    this.#prisma = options.prisma;
    this.#redis = options.redis;
    this.#cipher = options.cipher;
    this.#client = options.client;
    this.#prefix = options.prefix ?? 'email:rate-alert';
  }

  async notify(input: RateLimitAlertInput): Promise<RateLimitAlertOutcome> {
    if (!input.limitReachedThisReservation) return 'not-reached';
    const integration = await this.#prisma.slackIntegration.findUnique({
      where: { userId: input.userId },
    });
    if (!integration) return 'not-connected';

    const key = `${this.#prefix}:{${input.senderId}}:${input.hourWindow}`;
    const claim = randomUUID();
    const claimed = await this.#redis.set(key, claim, 'PX', markerTtlMs(input.hourWindow), 'NX');
    if (claimed !== 'OK') return 'duplicate';

    try {
      await this.#client.postWebhook(
        this.#cipher.decrypt(integration.webhookUrlEncrypted),
        buildRateLimitMessage(input),
      );
      return 'sent';
    } catch (error) {
      await this.#redis.eval(RELEASE_CLAIM_SCRIPT, 1, key, claim);
      throw error;
    }
  }
}

export function buildRateLimitMessage(
  input: Pick<RateLimitAlertInput, 'senderEmail' | 'hourlyLimit' | 'hourWindow'>,
): string {
  const start = new Date(`${input.hourWindow}:00:00.000Z`);
  const end = new Date(start.getTime() + 3_600_000);
  const time = (date: Date) => `${String(date.getUTCHours()).padStart(2, '0')}:00`;
  return [
    'ReachInbox sender rate limit reached',
    `Sender: ${input.senderEmail}`,
    `Limit: ${input.hourlyLimit} emails/hour`,
    `Window: ${time(start)}–${time(end)} UTC`,
  ].join('\n');
}

function markerTtlMs(hourWindow: string): number {
  const start = new Date(`${hourWindow}:00:00.000Z`).getTime();
  const afterWindow = start + 2 * 3_600_000;
  return Math.max(60_000, afterWindow - Date.now());
}
