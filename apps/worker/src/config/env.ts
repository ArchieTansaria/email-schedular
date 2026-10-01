import { z } from 'zod';

const connectionUrl = (protocols: readonly string[]) =>
  z.url().refine((value) => protocols.includes(new URL(value).protocol), {
    message: `URL must use one of these protocols: ${protocols.join(', ')}`,
  });

const infrastructureFieldsSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: connectionUrl(['postgres:', 'postgresql:']),
  REDIS_URL: connectionUrl(['redis:', 'rediss:']),
  ELASTICSEARCH_URL: connectionUrl(['http:', 'https:']),
  ELASTICSEARCH_API_KEY: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(1).optional(),
  ),
  APP_ENCRYPTION_KEY: z.string().min(32),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

const workerFieldsSchema = infrastructureFieldsSchema
  .extend({
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
    MIN_SEND_DELAY_MS: z.coerce.number().int().min(1),
    MAX_EMAILS_PER_HOUR_PER_SENDER: z.coerce.number().int().min(1),
    ETHEREAL_SENDER_1_USER: z.email(),
    ETHEREAL_SENDER_1_PASS: z.string().min(1),
    ETHEREAL_SENDER_2_USER: z.email(),
    ETHEREAL_SENDER_2_PASS: z.string().min(1),
  })
  .refine(
    (config) =>
      config.ETHEREAL_SENDER_1_USER.toLowerCase() !== config.ETHEREAL_SENDER_2_USER.toLowerCase(),
    {
      path: ['ETHEREAL_SENDER_2_USER'],
      message: 'Ethereal sender accounts must be different',
    },
  );

export type WorkerConfig = z.infer<typeof workerFieldsSchema>;
export type WorkerInfrastructureConfig = z.infer<typeof infrastructureFieldsSchema>;

export function parseWorkerConfig(input: Record<string, unknown>): WorkerConfig {
  return workerFieldsSchema.parse(input);
}

export function parseWorkerInfrastructureConfig(
  input: Record<string, unknown>,
): WorkerInfrastructureConfig {
  return infrastructureFieldsSchema.parse(input);
}
