import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildSmtpMessage, makeSmtpMessageId } from './message.js';

describe('SMTP message construction', () => {
  it('builds a stable Message-ID per Email identity', () => {
    const first = randomUUID();
    const second = randomUUID();

    expect(makeSmtpMessageId(first)).toBe(makeSmtpMessageId(first));
    expect(makeSmtpMessageId(first)).not.toBe(makeSmtpMessageId(second));
    expect(makeSmtpMessageId(first)).toBe(`<email-${first}@reachinbox.local>`);
  });

  it('uses authoritative delivery fields', () => {
    const emailId = randomUUID();

    expect(
      buildSmtpMessage({
        emailId,
        senderName: 'Sender Name',
        senderEmail: 'sender@example.test',
        recipientEmail: 'recipient@example.test',
        subject: 'Campaign subject',
        body: 'Campaign body',
      }),
    ).toEqual({
      from: { name: 'Sender Name', address: 'sender@example.test' },
      to: 'recipient@example.test',
      subject: 'Campaign subject',
      text: 'Campaign body',
      messageId: makeSmtpMessageId(emailId),
    });
  });
});
