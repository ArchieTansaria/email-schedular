import { describe, expect, it } from 'vitest';

import { EMAIL_QUEUE_NAME, SEND_EMAIL_JOB_NAME, makeEmailJobId } from './queue.js';

describe('email queue contract', () => {
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
