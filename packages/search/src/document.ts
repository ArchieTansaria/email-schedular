import { Prisma, type EmailStatus } from '@prisma/client';

export interface EmailSearchDocument {
  emailId: string;
  campaignId: string;
  userId: string;
  senderId: string;
  recipientEmail: string;
  senderEmail: string;
  subject: string;
  body: string;
  status: EmailStatus;
  originalScheduledAt: string;
  scheduledAt: string;
  sentAt: string | null;
  failureReason: string | null;
}

export const emailProjectionSelect = Prisma.validator<Prisma.EmailSelect>()({
  id: true,
  campaignId: true,
  userId: true,
  senderId: true,
  recipientEmail: true,
  originalScheduledAt: true,
  scheduledAt: true,
  status: true,
  sentAt: true,
  failureReason: true,
  campaign: { select: { subject: true, body: true } },
  sender: { select: { fromEmail: true } },
});

export type EmailProjectionRow = Prisma.EmailGetPayload<{
  select: typeof emailProjectionSelect;
}>;

export function buildEmailSearchDocument(email: EmailProjectionRow): EmailSearchDocument {
  return {
    emailId: email.id,
    campaignId: email.campaignId,
    userId: email.userId,
    senderId: email.senderId,
    recipientEmail: email.recipientEmail,
    senderEmail: email.sender.fromEmail,
    subject: email.campaign.subject,
    body: email.campaign.body,
    status: email.status,
    originalScheduledAt: email.originalScheduledAt.toISOString(),
    scheduledAt: email.scheduledAt.toISOString(),
    sentAt: email.sentAt?.toISOString() ?? null,
    failureReason: email.failureReason,
  };
}
