import { z } from 'zod';

const emptyStringToUndefined = (value: unknown): unknown => (value === '' ? undefined : value);

const optionalString = z.preprocess(emptyStringToUndefined, z.string().min(1).optional());
const optionalUrl = z.preprocess(emptyStringToUndefined, z.url().optional());

const urlWithProtocols = (protocols: readonly string[]) =>
  z.url().refine((value) => protocols.includes(new URL(value).protocol), {
    message: `URL must use one of these protocols: ${protocols.join(', ')}`,
  });

const positiveInteger = (name: string) =>
  z.coerce
    .number({ error: `${name} must be a number` })
    .int(`${name} must be an integer`)
    .positive(`${name} must be greater than zero`);

export const runtimeEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: urlWithProtocols(['postgres:', 'postgresql:']),
  REDIS_URL: urlWithProtocols(['redis:', 'rediss:']),
  ELASTICSEARCH_URL: urlWithProtocols(['http:', 'https:']),
  ELASTICSEARCH_API_KEY: optionalString,
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must contain at least 32 characters'),
  APP_ENCRYPTION_KEY: z.string().min(32, 'APP_ENCRYPTION_KEY must contain at least 32 characters'),
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  GOOGLE_CALLBACK_URL: optionalUrl,
  SLACK_CLIENT_ID: optionalString,
  SLACK_CLIENT_SECRET: optionalString,
  SLACK_CALLBACK_URL: optionalUrl,
  ETHEREAL_SENDER_1_USER: optionalString,
  ETHEREAL_SENDER_1_PASS: optionalString,
  ETHEREAL_SENDER_2_USER: optionalString,
  ETHEREAL_SENDER_2_PASS: optionalString,
  WORKER_CONCURRENCY: positiveInteger('WORKER_CONCURRENCY').max(
    100,
    'WORKER_CONCURRENCY must be at most 100',
  ),
  MIN_SEND_DELAY_MS: positiveInteger('MIN_SEND_DELAY_MS'),
  MAX_EMAILS_PER_HOUR_PER_SENDER: positiveInteger('MAX_EMAILS_PER_HOUR_PER_SENDER'),
});

export type RuntimeEnv = z.infer<typeof runtimeEnvSchema>;

export class EnvironmentValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid environment configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'EnvironmentValidationError';
    this.issues = issues;
  }
}

export function parseRuntimeEnv(input: Record<string, unknown>): RuntimeEnv {
  const result = runtimeEnvSchema.safeParse(input);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.join('.') || 'environment';
      return `${path}: ${issue.message}`;
    });

    throw new EnvironmentValidationError(issues);
  }

  return result.data;
}

export interface RedisConnectionSettings {
  url: string;
  maxRetriesPerRequest: null;
}

export function getRedisConnectionSettings(
  env: Pick<RuntimeEnv, 'REDIS_URL'>,
): RedisConnectionSettings {
  return {
    url: env.REDIS_URL,
    maxRetriesPerRequest: null,
  };
}
