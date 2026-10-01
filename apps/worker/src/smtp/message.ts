import type { SendMailOptions } from 'nodemailer';

import type { DeliveryInput } from './types.js';

export function makeSmtpMessageId(emailId: string): string {
  return `<email-${emailId}@reachinbox.local>`;
}

export function buildSmtpMessage(input: DeliveryInput): SendMailOptions {
  return {
    from: { name: input.senderName, address: input.senderEmail },
    to: input.recipientEmail,
    subject: input.subject,
    text: input.body,
    messageId: makeSmtpMessageId(input.emailId),
  };
}
