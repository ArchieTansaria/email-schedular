import { parseRuntimeEnv, type RuntimeEnv } from '@reachinbox/shared/env';
import { z } from 'zod';

const apiFieldsSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  FRONTEND_URL: z.url().default('http://localhost:5173'),
});

export interface ApiConfig extends RuntimeEnv {
  PORT: number;
  LOG_LEVEL: z.infer<typeof apiFieldsSchema>['LOG_LEVEL'];
  FRONTEND_URL: string;
}

export function parseApiConfig(input: Record<string, unknown>): ApiConfig {
  return {
    ...parseRuntimeEnv(input),
    ...apiFieldsSchema.parse(input),
  };
}
