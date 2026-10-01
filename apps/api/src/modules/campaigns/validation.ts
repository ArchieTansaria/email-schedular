import type { RuntimeEnv } from '@reachinbox/shared/env';
import { z } from 'zod';

import { SchedulingValidationError } from './errors.js';
import { normalizeRecipients } from './recipients.js';

export const MAX_CAMPAIGN_RECIPIENTS = 10_000;

export type SchedulingLimits = Pick<
  RuntimeEnv,
  'MIN_SEND_DELAY_MS' | 'MAX_EMAILS_PER_HOUR_PER_SENDER'
>;

export interface ScheduleCampaignInput {
  userId: string;
  senderId: string;
  subject: string;
  body: string;
  startAt: Date;
  delayMs: number;
  hourlyLimit: number;
  idempotencyKey: string;
  recipients: string[];
}

export interface ValidatedScheduleCampaignInput extends Omit<ScheduleCampaignInput, 'recipients'> {
  recipients: string[];
}

const scheduleCampaignSchema = z.object({
  userId: z.uuid(),
  senderId: z.uuid(),
  subject: z.string().trim().min(1, 'subject must not be empty'),
  body: z.string().trim().min(1, 'body must not be empty'),
  startAt: z.date(),
  delayMs: z.number().int().nonnegative().max(2_147_483_647),
  hourlyLimit: z.number().int().positive().max(2_147_483_647),
  idempotencyKey: z.string().trim().min(1, 'idempotencyKey must not be empty').max(255),
  recipients: z.array(z.string()).min(1, 'recipients must not be empty'),
});

export function validateScheduleCampaignInput(
  input: ScheduleCampaignInput,
  limits: SchedulingLimits,
): ValidatedScheduleCampaignInput {
  const parsed = scheduleCampaignSchema.safeParse(input);
  if (!parsed.success) {
    throw new SchedulingValidationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }

  const issues: string[] = [];
  if (parsed.data.delayMs < limits.MIN_SEND_DELAY_MS) {
    issues.push(`delayMs must be at least ${limits.MIN_SEND_DELAY_MS}`);
  }
  if (parsed.data.hourlyLimit > limits.MAX_EMAILS_PER_HOUR_PER_SENDER) {
    issues.push(`hourlyLimit must be at most ${limits.MAX_EMAILS_PER_HOUR_PER_SENDER}`);
  }
  if (issues.length > 0) throw new SchedulingValidationError(issues);

  const recipients = normalizeRecipients(parsed.data.recipients);
  if (recipients.length === 0) {
    throw new SchedulingValidationError(['recipients must contain at least one email address']);
  }
  if (recipients.length > MAX_CAMPAIGN_RECIPIENTS) {
    throw new SchedulingValidationError([
      `recipients must contain at most ${MAX_CAMPAIGN_RECIPIENTS} normalized addresses`,
    ]);
  }

  return { ...parsed.data, recipients };
}
