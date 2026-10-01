import { z } from 'zod';

const connectionUrl = (protocols: readonly string[]) =>
  z.url().refine((value) => protocols.includes(new URL(value).protocol), {
    message: `URL must use one of these protocols: ${protocols.join(', ')}`,
  });

const workerFieldsSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: connectionUrl(['postgres:', 'postgresql:']),
    REDIS_URL: connectionUrl(['redis:', 'rediss:']),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
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

export function parseWorkerConfig(input: Record<string, unknown>): WorkerConfig {
  return workerFieldsSchema.parse(input);
}
