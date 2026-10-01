import { EmailStatus, type PrismaClient } from '@prisma/client';
import type { EmailSearchProjection } from '@reachinbox/search';
import type { RateLimitNotifier } from '@reachinbox/slack';
import { SEND_EMAIL_JOB_NAME } from '@reachinbox/shared/queue';
import { DelayedError, type Job } from 'bullmq';
import { z } from 'zod';

import { getEffectiveSendLimits } from '../rate-limit/effective-limits.js';
import type { SendPermitGate } from '../rate-limit/send-permit.js';
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
  sendPermitGate: SendPermitGate;
  platformLimits: {
    minSendDelayMs: number;
    maxEmailsPerHourPerSender: number;
  };
  logger: ProcessorLogger;
  searchProjection?: Pick<EmailSearchProjection, 'projectEmail'>;
  rateLimitNotifier?: RateLimitNotifier;
  now?: () => Date;
}

export class EmailProcessor {
  readonly #prisma: PrismaClient;
  readonly #emailSender: EmailSender;
  readonly #sendPermitGate: SendPermitGate;
  readonly #platformLimits: EmailProcessorOptions['platformLimits'];
  readonly #logger: ProcessorLogger;
  readonly #searchProjection: Pick<EmailSearchProjection, 'projectEmail'>;
  readonly #rateLimitNotifier: RateLimitNotifier;
  readonly #now: () => Date;

  constructor({
    prisma,
    emailSender,
    sendPermitGate,
    platformLimits,
    logger,
    searchProjection = { projectEmail: async () => false },
    rateLimitNotifier = { notify: async () => 'not-connected' },
    now = () => new Date(),
  }: EmailProcessorOptions) {
    this.#prisma = prisma;
    this.#emailSender = emailSender;
    this.#sendPermitGate = sendPermitGate;
    this.#platformLimits = platformLimits;
    this.#logger = logger;
    this.#searchProjection = searchProjection;
    this.#rateLimitNotifier = rateLimitNotifier;
    this.#now = now;
  }

  async process(
    job: Pick<Job<unknown>, 'id' | 'name' | 'data' | 'token' | 'moveToDelayed'>,
  ): Promise<EmailJobResult> {
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

    if (!email.sender.active) {
      const claimed = await claimScheduledEmail(this.#prisma, emailId);
      if (!claimed) return { outcome: 'claim-lost' };
      const error = new DefinitiveDeliveryError('Sender is inactive');
      await this.#markFailed(emailId, 'Sender is inactive');
      await this.#projectSafely(emailId);
      throw error;
    }

    const effectiveLimits = getEffectiveSendLimits(email.campaign, this.#platformLimits);
    let permit;
    try {
      permit = await this.#sendPermitGate.acquire({
        senderId: email.senderId,
        now: this.#now(),
        delayMs: effectiveLimits.delayMs,
        hourlyLimit: effectiveLimits.hourlyLimit,
      });
    } catch (error) {
      this.#logger.error(
        { error, jobId: job.id, emailId, senderId: email.senderId },
        'Send permit check failed; Email remains SCHEDULED',
      );
      throw error;
    }

    if (!permit.allowed) {
      if (permit.reason === 'HOURLY_LIMIT') {
        await this.#notifyRateLimitSafely({
          userId: email.userId,
          senderId: email.senderId,
          senderEmail: email.sender.fromEmail,
          hourWindow: permit.hourWindow,
          hourlyLimit: effectiveLimits.hourlyLimit,
          limitReachedThisReservation: true,
        });
      }
      return this.#rescheduleBlockedJob(job, emailId, email.senderId, permit);
    }

    this.#logger.info(
      {
        jobId: job.id,
        emailId,
        senderId: email.senderId,
        hourWindow: permit.hourWindow,
        reservationCount: permit.count,
        hourlyLimit: effectiveLimits.hourlyLimit,
        limitReachedThisReservation: permit.limitReachedThisReservation,
      },
      'Send permit reserved',
    );

    await this.#notifyRateLimitSafely({
      userId: email.userId,
      senderId: email.senderId,
      senderEmail: email.sender.fromEmail,
      hourWindow: permit.hourWindow,
      hourlyLimit: effectiveLimits.hourlyLimit,
      limitReachedThisReservation: permit.limitReachedThisReservation,
    });

    const claimed = await claimScheduledEmail(this.#prisma, emailId);
    if (!claimed) {
      this.#logger.info({ jobId: job.id, emailId }, 'Email claim was won by another execution');
      return { outcome: 'claim-lost' };
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
        await this.#projectSafely(emailId);
        throw error;
      }

      const ambiguous =
        error instanceof AmbiguousDeliveryError
          ? error
          : new AmbiguousDeliveryError('SMTP delivery outcome is uncertain', error);
      await this.#recordAmbiguousOutcome(emailId);
      await this.#projectSafely(emailId);
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

    await this.#projectSafely(emailId);

    return { outcome: 'sent' };
  }

  async #rescheduleBlockedJob(
    job: Pick<Job<unknown>, 'id' | 'token' | 'moveToDelayed'>,
    emailId: string,
    senderId: string,
    permit: Extract<Awaited<ReturnType<SendPermitGate['acquire']>>, { allowed: false }>,
  ): Promise<never | EmailJobResult> {
    if (!job.token) throw new Error('Active BullMQ job is missing its lock token');

    const updated = await this.#prisma.email.updateMany({
      where: { id: emailId, status: EmailStatus.SCHEDULED },
      data: { scheduledAt: permit.retryAt },
    });
    if (updated.count !== 1) {
      this.#logger.info(
        { jobId: job.id, emailId },
        'Email changed state before throttled rescheduling; job completes without SMTP',
      );
      return { outcome: 'claim-lost' };
    }

    this.#logger.info(
      {
        jobId: job.id,
        emailId,
        senderId,
        reason: permit.reason,
        retryAt: permit.retryAt,
        hourWindow: permit.hourWindow,
      },
      'Email throttled and returning to delayed queue',
    );
    await job.moveToDelayed(permit.retryAt.getTime(), job.token);
    await this.#projectSafely(emailId);
    throw new DelayedError();
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

  async #projectSafely(emailId: string): Promise<void> {
    try {
      await this.#searchProjection.projectEmail(emailId);
    } catch (error) {
      this.#logger.error(
        { error, emailId, operation: 'project-email' },
        'Elasticsearch projection failed after durable Email state change',
      );
    }
  }

  async #notifyRateLimitSafely(input: Parameters<RateLimitNotifier['notify']>[0]): Promise<void> {
    try {
      await this.#rateLimitNotifier.notify(input);
    } catch (error) {
      this.#logger.error(
        {
          errorName: error instanceof Error ? error.name : 'UnknownError',
          senderId: input.senderId,
          hourWindow: input.hourWindow,
          operation: 'slack-rate-limit-alert',
        },
        'Slack rate-limit notification failed; email delivery continues',
      );
    }
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
