import { EmailStatus, type PrismaClient } from '@prisma/client';
import { SEND_EMAIL_JOB_NAME } from '@reachinbox/shared/queue';
import type { Job } from 'bullmq';
import { z } from 'zod';

import { makeSmtpMessageId } from '../smtp/message.js';
import {
  AmbiguousDeliveryError,
  DefinitiveDeliveryError,
  SenderConfigurationError,
  type DeliveryInput,
  type EmailSender,
} from '../smtp/types.js';

const sendEmailJobSchema = z
  .object({
    emailId: z.uuid(),
  })
  .strict();

interface ProcessorLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export type EmailJobOutcome =
  | 'sent'
  | 'missing'
  | 'already-sent'
  | 'already-failed'
  | 'already-processing'
  | 'claim-lost';

export interface EmailJobResult {
  outcome: EmailJobOutcome;
}

export interface EmailProcessorOptions {
  prisma: PrismaClient;
  emailSender: EmailSender;
  logger: ProcessorLogger;
  now?: () => Date;
}

export class EmailProcessor {
  readonly #prisma: PrismaClient;
  readonly #emailSender: EmailSender;
  readonly #logger: ProcessorLogger;
  readonly #now: () => Date;

  constructor({ prisma, emailSender, logger, now = () => new Date() }: EmailProcessorOptions) {
    this.#prisma = prisma;
    this.#emailSender = emailSender;
    this.#logger = logger;
    this.#now = now;
  }

  async process(job: Pick<Job<unknown>, 'id' | 'name' | 'data'>): Promise<EmailJobResult> {
    const emailId = validateJob(job);
    const email = await this.#prisma.email.findUnique({
      where: { id: emailId },
      include: { campaign: true, sender: true },
    });

    if (!email) {
      this.#logger.warn({ jobId: job.id, emailId }, 'Queue job references a missing Email');
      return { outcome: 'missing' };
    }

    const existingOutcome = outcomeForExistingStatus(email.status);
    if (existingOutcome) {
      this.#logger.info(
        { jobId: job.id, emailId, status: email.status },
        'Email job is already terminal or claimed; SMTP skipped',
      );
      return { outcome: existingOutcome };
    }

    const claimed = await claimScheduledEmail(this.#prisma, emailId);
    if (!claimed) {
      this.#logger.info({ jobId: job.id, emailId }, 'Email claim was won by another execution');
      return { outcome: 'claim-lost' };
    }

    if (!email.sender.active) {
      const error = new DefinitiveDeliveryError('Sender is inactive');
      await this.#markFailed(emailId, 'Sender is inactive');
      throw error;
    }

    const deliveryInput: DeliveryInput = {
      emailId,
      senderName: email.sender.fromName,
      senderEmail: email.sender.fromEmail,
      recipientEmail: email.recipientEmail,
      subject: email.campaign.subject,
      body: email.campaign.body,
    };

    let delivery;
    try {
      delivery = await this.#emailSender.send(deliveryInput);
    } catch (error) {
      if (error instanceof SenderConfigurationError || error instanceof DefinitiveDeliveryError) {
        const failureReason =
          error instanceof SenderConfigurationError
            ? 'No Ethereal account is configured for this sender'
            : error.message;
        await this.#markFailed(emailId, failureReason);
        throw error;
      }

      const ambiguous =
        error instanceof AmbiguousDeliveryError
          ? error
          : new AmbiguousDeliveryError('SMTP delivery outcome is uncertain', error);
      await this.#recordAmbiguousOutcome(emailId);
      this.#logger.error(
        { error: ambiguous, jobId: job.id, emailId },
        'SMTP outcome is ambiguous; Email remains PROCESSING',
      );
      throw ambiguous;
    }

    const expectedMessageId = makeSmtpMessageId(emailId);
    if (delivery.messageId !== expectedMessageId) {
      this.#logger.warn(
        { jobId: job.id, emailId, expectedMessageId, actualMessageId: delivery.messageId },
        'SMTP returned a different Message-ID than requested',
      );
    }

    try {
      const finalized = await this.#prisma.email.updateMany({
        where: { id: emailId, status: EmailStatus.PROCESSING },
        data: {
          status: EmailStatus.SENT,
          sentAt: this.#now(),
          smtpMessageId: delivery.messageId,
          previewUrl: delivery.previewUrl,
          failureReason: null,
        },
      });
      if (finalized.count !== 1) {
        throw new Error('Claimed Email could not be finalized as SENT');
      }
    } catch (error) {
      this.#logger.error(
        { error, jobId: job.id, emailId },
        'SMTP was accepted but SENT finalization failed; automatic resend disabled',
      );
      throw new AmbiguousDeliveryError('SMTP accepted but database finalization failed', error);
    }

    return { outcome: 'sent' };
  }

  async #markFailed(emailId: string, failureReason: string): Promise<void> {
    await this.#prisma.email.updateMany({
      where: { id: emailId, status: EmailStatus.PROCESSING },
      data: { status: EmailStatus.FAILED, failureReason },
    });
  }

  async #recordAmbiguousOutcome(emailId: string): Promise<void> {
    await this.#prisma.email.updateMany({
      where: { id: emailId, status: EmailStatus.PROCESSING },
      data: { failureReason: 'SMTP outcome is uncertain; automatic resend disabled' },
    });
  }
}

export async function claimScheduledEmail(prisma: PrismaClient, emailId: string): Promise<boolean> {
  const result = await prisma.email.updateMany({
    where: { id: emailId, status: EmailStatus.SCHEDULED },
    data: { status: EmailStatus.PROCESSING, failureReason: null },
  });
  return result.count === 1;
}

function validateJob(job: Pick<Job<unknown>, 'id' | 'name' | 'data'>): string {
  if (job.name !== SEND_EMAIL_JOB_NAME) {
    throw new Error(`Unsupported email queue job name: ${job.name}`);
  }

  const parsed = sendEmailJobSchema.safeParse(job.data);
  if (!parsed.success) {
    throw new Error('Invalid send-email job payload: expected { emailId: UUID }');
  }
  return parsed.data.emailId;
}

function outcomeForExistingStatus(status: EmailStatus): EmailJobOutcome | undefined {
  if (status === EmailStatus.SENT) return 'already-sent';
  if (status === EmailStatus.FAILED) return 'already-failed';
  if (status === EmailStatus.PROCESSING) return 'already-processing';
  return undefined;
}
