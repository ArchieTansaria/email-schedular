import { parseRuntimeEnv, type RuntimeEnv } from '@reachinbox/shared/env';
import { z } from 'zod';

const optionalUuid = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.uuid().optional(),
);

const apiFieldsSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  FRONTEND_URL: z.url().default('http://localhost:5173'),
  DEV_AUTH_USER_ID: optionalUuid,
});

export type ApiConfig = RuntimeEnv & z.infer<typeof apiFieldsSchema>;

export function parseApiConfig(input: Record<string, unknown>): ApiConfig {
  return {
    ...parseRuntimeEnv(input),
    ...apiFieldsSchema.parse(input),
  };
}
