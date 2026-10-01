import { RedisStore } from 'connect-redis';
import session, { type Store } from 'express-session';
import { createClient, type RedisClientType } from 'redis';

export const SESSION_COOKIE_NAME = 'reachinbox.sid';
export const SESSION_PREFIX = 'session:';
export const SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    googleOAuthAttempt?: {
      state: string;
      nonce: string;
      createdAt: number;
    };
  }
}

export interface SessionInfrastructure {
  client: RedisClientType;
  middleware: ReturnType<typeof session>;
  close(): Promise<void>;
}

export function createSessionMiddleware(options: {
  store: Store;
  secret: string;
  production: boolean;
}): ReturnType<typeof session> {
  return session({
    name: SESSION_COOKIE_NAME,
    store: options.store,
    secret: options.secret,
    resave: false,
    saveUninitialized: false,
    rolling: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: options.production,
      path: '/',
      maxAge: SESSION_TTL_MS,
    },
  });
}

export async function createRedisSessionInfrastructure(options: {
  redisUrl: string;
  secret: string;
  production: boolean;
  prefix?: string;
}): Promise<SessionInfrastructure> {
  const client = createClient({ url: options.redisUrl });
  await client.connect();

  const store = new RedisStore({
    client,
    prefix: options.prefix ?? SESSION_PREFIX,
    ttl: SESSION_TTL_MS / 1_000,
    disableTouch: true,
  });

  return {
    client,
    middleware: createSessionMiddleware({
      store,
      secret: options.secret,
      production: options.production,
    }),
    async close() {
      if (client.isOpen) await client.quit();
    },
  };
}
