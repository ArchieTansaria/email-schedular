import { describe, expect, it } from 'vitest';

import {
  EMAIL_QUEUE_NAME,
  SEND_EMAIL_JOB_NAME,
  emailJobRetryOptions,
  emailJobRetrySchema,
  makeEmailJobId,
} from './queue.js';

describe('email queue contract', () => {
  it('validates configurable retry budgets and provides bounded defaults', () => {
    expect(emailJobRetryOptions()).toEqual({
      attempts: 5,
      backoff: { type: 'exponential', delay: 2_000 },
    });
    expect(
      emailJobRetryOptions(
        emailJobRetrySchema.parse({ EMAIL_JOB_ATTEMPTS: '3', EMAIL_JOB_BACKOFF_MS: '100' }),
      ),
    ).toEqual({ attempts: 3, backoff: { type: 'exponential', delay: 100 } });
    for (const config of [
      { EMAIL_JOB_ATTEMPTS: 0 },
      { EMAIL_JOB_ATTEMPTS: 11 },
      { EMAIL_JOB_BACKOFF_MS: 0 },
      { EMAIL_JOB_BACKOFF_MS: 60_001 },
    ]) {
      expect(() => emailJobRetrySchema.parse(config)).toThrow();
    }
  });
  it('centralizes queue and job names', () => {
    expect(EMAIL_QUEUE_NAME).toBe('email-send');
    expect(SEND_EMAIL_JOB_NAME).toBe('send-email');
  });

  it('builds the deterministic BullMQ job ID', () => {
    const emailId = 'c15c9458-6e6f-40a6-b67f-5858324af4e9';

    expect(makeEmailJobId(emailId)).toBe(`email-${emailId}`);
    expect(makeEmailJobId(emailId)).toBe(makeEmailJobId(emailId));
  });
});
