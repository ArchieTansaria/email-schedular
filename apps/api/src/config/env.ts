import { parseRuntimeEnv, type RuntimeEnv } from '@reachinbox/shared/env';
import { z } from 'zod';

const slackConfigurationSchema = z
  .object({
    SLACK_CLIENT_ID: z.string().min(1).optional(),
    SLACK_CLIENT_SECRET: z.string().min(1).optional(),
    SLACK_CALLBACK_URL: z.url().optional(),
  })
  .refine(
    (value) =>
      [value.SLACK_CLIENT_ID, value.SLACK_CLIENT_SECRET, value.SLACK_CALLBACK_URL].every(Boolean) ||
      [value.SLACK_CLIENT_ID, value.SLACK_CLIENT_SECRET, value.SLACK_CALLBACK_URL].every(
        (entry) => !entry,
      ),
    { message: 'Slack OAuth configuration must be either complete or entirely omitted' },
  );

const googleConfigurationSchema = z
  .object({
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    GOOGLE_CALLBACK_URL: z.url().optional(),
  })
  .refine(
    (value) =>
      [value.GOOGLE_CLIENT_ID, value.GOOGLE_CLIENT_SECRET, value.GOOGLE_CALLBACK_URL].every(
        Boolean,
      ) ||
      [value.GOOGLE_CLIENT_ID, value.GOOGLE_CLIENT_SECRET, value.GOOGLE_CALLBACK_URL].every(
        (entry) => !entry,
      ),
    { message: 'Google OAuth configuration must be either complete or entirely omitted' },
  );

const apiFieldsSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  FRONTEND_URL: z.url().default('http://localhost:5173'),
});

export type ApiConfig = RuntimeEnv & z.infer<typeof apiFieldsSchema>;

export function parseApiConfig(input: Record<string, unknown>): ApiConfig {
  const config = {
    ...parseRuntimeEnv(input),
    ...apiFieldsSchema.parse(input),
  };
  googleConfigurationSchema.parse(config);
  slackConfigurationSchema.parse(config);
  return config;
}
