import { randomBytes } from 'node:crypto';

import type { Redis } from 'ioredis';

export const SLACK_OAUTH_STATE_TTL_SECONDS = 600;

export class SlackOAuthStateStore {
  readonly #redis: Pick<Redis, 'set' | 'getdel'>;
  readonly #prefix: string;

  constructor(redis: Pick<Redis, 'set' | 'getdel'>, prefix = 'slack:oauth-state') {
    this.#redis = redis;
    this.#prefix = prefix;
  }

  async create(userId: string): Promise<string> {
    const state = randomBytes(32).toString('base64url');
    const stored = await this.#redis.set(
      this.#key(state),
      userId,
      'EX',
      SLACK_OAUTH_STATE_TTL_SECONDS,
      'NX',
    );
    if (stored !== 'OK') throw new Error('Could not reserve Slack OAuth state');
    return state;
  }

  consume(state: string): Promise<string | null> {
    return this.#redis.getdel(this.#key(state));
  }

  #key(state: string): string {
    return `${this.#prefix}:${state}`;
  }
}
