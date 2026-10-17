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
    ...(input.bodyHtml ? { html: input.bodyHtml } : {}),
    ...(input.attachments?.length
      ? {
          attachments: input.attachments.map((attachment) => ({
            filename: attachment.filename,
            contentType: attachment.contentType,
            content: Buffer.from(attachment.contentBase64, 'base64'),
            contentDisposition: 'attachment' as const,
          })),
        }
      : {}),
    messageId: makeSmtpMessageId(input.emailId),
  };
}
