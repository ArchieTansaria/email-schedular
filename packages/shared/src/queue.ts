import { z } from 'zod';

export const EMAIL_QUEUE_NAME = 'email-send' as const;
export const SEND_EMAIL_JOB_NAME = 'send-email' as const;

export const emailJobRetrySchema = z.object({
  EMAIL_JOB_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  EMAIL_JOB_BACKOFF_MS: z.coerce.number().int().min(1).max(60_000).default(2_000),
});

export type EmailJobRetryConfig = z.infer<typeof emailJobRetrySchema>;

export function emailJobRetryOptions(config: EmailJobRetryConfig = emailJobRetrySchema.parse({})) {
  return {
    attempts: config.EMAIL_JOB_ATTEMPTS,
    backoff: { type: 'exponential' as const, delay: config.EMAIL_JOB_BACKOFF_MS },
  };
}

export interface SendEmailJobData {
  emailId: string;
}

export function makeEmailJobId(emailId: string): string {
  return `email-${emailId}`;
}
