import { randomUUID } from 'node:crypto';

import type { SentMessageInfo } from 'nodemailer';
import { describe, expect, it, vi } from 'vitest';

import { makeSmtpMessageId } from './message.js';
import { EtherealEmailSender } from './ethereal-email-sender.js';
import {
  AmbiguousDeliveryError,
  DefinitiveDeliveryError,
  SenderConfigurationError,
} from './types.js';

const input = (senderEmail: string) => ({
  emailId: randomUUID(),
  senderName: 'Configured Sender',
  senderEmail,
  recipientEmail: 'recipient@example.test',
  subject: 'Subject',
  body: 'Body',
});

describe('EtherealEmailSender', () => {
  it('maps two sender addresses to their own reusable transporter', async () => {
    const sends = new Map<string, ReturnType<typeof vi.fn>>();
    const close = vi.fn();
    const sender = new EtherealEmailSender(
      [
        { email: 'sender-a@ethereal.email', password: 'secret-a' },
        { email: 'sender-b@ethereal.email', password: 'secret-b' },
      ],
      (account) => {
        const sendMail = vi.fn(
          async (message) =>
            ({
              messageId: message.messageId,
              response: `250 Accepted [STATUS=new MSGID=${account.email}]`,
            }) as SentMessageInfo,
        );
        sends.set(account.email, sendMail);
        return { sendMail, close };
      },
    );

    const first = input('SENDER-A@ETHEREAL.EMAIL');
    const second = input('sender-b@ethereal.email');
    const firstResult = await sender.send(first);
    const secondResult = await sender.send(second);

    expect(sends.get('sender-a@ethereal.email')).toHaveBeenCalledOnce();
    expect(sends.get('sender-b@ethereal.email')).toHaveBeenCalledOnce();
    expect(firstResult).toEqual({
      messageId: makeSmtpMessageId(first.emailId),
      previewUrl: 'https://ethereal.email/message/sender-a@ethereal.email',
    });
    expect(secondResult.messageId).toBe(makeSmtpMessageId(second.emailId));

    sender.close();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('rejects an unknown sender without calling a configured transporter', async () => {
    const sendMail = vi.fn();
    const sender = new EtherealEmailSender(
      [{ email: 'sender-a@ethereal.email', password: 'secret-a' }],
      () => ({ sendMail, close: vi.fn() }),
    );

    await expect(sender.send(input('unknown@ethereal.email'))).rejects.toBeInstanceOf(
      SenderConfigurationError,
    );
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('classifies permanent SMTP rejection separately from ambiguous transport failure', async () => {
    const account = [{ email: 'sender@ethereal.email', password: 'secret' }];
    const permanent = new EtherealEmailSender(account, () => ({
      sendMail: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('rejected'), { responseCode: 550 })),
      close: vi.fn(),
    }));
    const ambiguous = new EtherealEmailSender(account, () => ({
      sendMail: vi.fn().mockRejectedValue(new Error('connection closed')),
      close: vi.fn(),
    }));

    await expect(permanent.send(input(account[0]!.email))).rejects.toBeInstanceOf(
      DefinitiveDeliveryError,
    );
    await expect(ambiguous.send(input(account[0]!.email))).rejects.toBeInstanceOf(
      AmbiguousDeliveryError,
    );
  });
});
