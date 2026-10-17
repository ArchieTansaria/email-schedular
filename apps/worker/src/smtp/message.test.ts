import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildSmtpMessage, makeSmtpMessageId } from './message.js';

describe('SMTP message construction', () => {
  it('sends both body alternatives and decodes persisted attachments', () => {
    const message = buildSmtpMessage({
      emailId: randomUUID(),
      senderName: 'Sender',
      senderEmail: 'a@example.test',
      recipientEmail: 'b@example.test',
      subject: 'Formatted',
      body: 'Hello',
      bodyHtml: '<p><strong>Hello</strong></p>',
      attachments: [
        {
          filename: 'hello.txt',
          contentType: 'text/plain',
          contentBase64: Buffer.from('hello').toString('base64'),
        },
      ],
    });
    expect(message.text).toBe('Hello');
    expect(message.html).toBe('<p><strong>Hello</strong></p>');
    expect(message.attachments).toEqual([
      {
        filename: 'hello.txt',
        contentType: 'text/plain',
        content: Buffer.from('hello'),
        contentDisposition: 'attachment',
      },
    ]);
  });
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
