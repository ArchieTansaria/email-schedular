import { parseRuntimeEnv, type RuntimeEnv } from '@reachinbox/shared/env';
import { z } from 'zod';

const workerFieldsSchema = z.object({
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export interface WorkerConfig extends RuntimeEnv {
  LOG_LEVEL: z.infer<typeof workerFieldsSchema>['LOG_LEVEL'];
}

export function parseWorkerConfig(input: Record<string, unknown>): WorkerConfig {
  return {
    ...parseRuntimeEnv(input),
    ...workerFieldsSchema.parse(input),
  };
}
