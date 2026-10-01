import { randomUUID } from 'node:crypto';

import { makeEmailJobId } from '@reachinbox/shared/queue';
import { EmailStatus, Prisma, type PrismaClient } from '@prisma/client';

import type { EnqueueEmailJobInput } from '../../queue/email-queue.js';
import {
  CampaignEnqueueError,
  IdempotencyConflictError,
  SenderUnavailableError,
} from './errors.js';
import { planSchedule } from './schedule-planner.js';
import {
  validateScheduleCampaignInput,
  type ScheduleCampaignInput,
  type SchedulingLimits,
  type ValidatedScheduleCampaignInput,
} from './validation.js';

interface EmailJobProducer {
  enqueueEmailJobsBulk(inputs: readonly EnqueueEmailJobInput[]): Promise<unknown>;
}

interface SchedulerLogger {
  error(bindings: Record<string, unknown>, message: string): void;
}

export interface CampaignSchedulerOptions {
  prisma: PrismaClient;
  producer: EmailJobProducer;
  limits: SchedulingLimits;
  logger: SchedulerLogger;
  now?: () => Date;
  generateEmailId?: () => string;
}

export interface ScheduleCampaignResult {
  campaignId: string;
  totalRecipients: number;
  startAt: Date;
  firstScheduledAt: Date;
  lastScheduledAt: Date;
}

const campaignWithEmails = Prisma.validator<Prisma.CampaignInclude>()({
  emails: {
    orderBy: [{ originalScheduledAt: 'asc' }, { id: 'asc' }],
  },
});

type CampaignWithEmails = Prisma.CampaignGetPayload<{ include: typeof campaignWithEmails }>;

export class CampaignScheduler {
  readonly #prisma: PrismaClient;
  readonly #producer: EmailJobProducer;
  readonly #limits: SchedulingLimits;
  readonly #logger: SchedulerLogger;
  readonly #now: () => Date;
  readonly #generateEmailId: () => string;

  constructor({
    prisma,
    producer,
    limits,
    logger,
    now = () => new Date(),
    generateEmailId = randomUUID,
  }: CampaignSchedulerOptions) {
    this.#prisma = prisma;
    this.#producer = producer;
    this.#limits = limits;
    this.#logger = logger;
    this.#now = now;
    this.#generateEmailId = generateEmailId;
  }

  async scheduleCampaign(rawInput: ScheduleCampaignInput): Promise<ScheduleCampaignResult> {
    const input = validateScheduleCampaignInput(rawInput, this.#limits);
    const now = this.#now();
    const existing = await this.#findCampaign(input.userId, input.idempotencyKey);
    const campaign = existing ?? (await this.#createCampaign(input, now));

    if (!isSameSchedulingIntent(campaign, input)) {
      throw new IdempotencyConflictError();
    }

    try {
      await this.ensureCampaignJobsEnqueued(campaign.id);
    } catch (cause) {
      this.#logger.error(
        { cause, campaignId: campaign.id, userId: campaign.userId },
        'Campaign persisted but queue enqueue failed',
      );
      throw new CampaignEnqueueError(campaign.id, cause);
    }

    return summarizeCampaign(campaign);
  }

  async ensureCampaignJobsEnqueued(campaignId: string): Promise<void> {
    const emails = await this.#prisma.email.findMany({
      where: { campaignId, status: EmailStatus.SCHEDULED },
      select: { id: true, bullJobId: true, scheduledAt: true },
      orderBy: { scheduledAt: 'asc' },
    });

    if (emails.length === 0) return;
    await this.#producer.enqueueEmailJobsBulk(
      emails.map((email) => ({
        emailId: email.id,
        bullJobId: email.bullJobId,
        scheduledAt: email.scheduledAt,
      })),
    );
  }

  async #createCampaign(
    input: ValidatedScheduleCampaignInput,
    now: Date,
  ): Promise<CampaignWithEmails> {
    const plannedTimes = planSchedule({
      recipientCount: input.recipients.length,
      startAt: input.startAt,
      now,
      delayMs: input.delayMs,
      hourlyLimit: input.hourlyLimit,
    });
    const emailRows = input.recipients.map((recipientEmail, index) => {
      const id = this.#generateEmailId();
      const scheduledAt = plannedTimes[index];
      if (!scheduledAt) throw new Error('Schedule planner returned too few timestamps');

      return {
        id,
        userId: input.userId,
        senderId: input.senderId,
        recipientEmail,
        originalScheduledAt: scheduledAt,
        scheduledAt,
        status: EmailStatus.SCHEDULED,
        bullJobId: makeEmailJobId(id),
      };
    });

    try {
      return await this.#prisma.$transaction(async (transaction) => {
        const sender = await transaction.sender.findUnique({ where: { id: input.senderId } });
        if (!sender || sender.userId !== input.userId || !sender.active) {
          throw new SenderUnavailableError();
        }

        const campaign = await transaction.campaign.create({
          data: {
            userId: input.userId,
            senderId: input.senderId,
            subject: input.subject,
            body: input.body,
            startAt: input.startAt,
            delayMs: input.delayMs,
            hourlyLimit: input.hourlyLimit,
            totalRecipients: input.recipients.length,
            idempotencyKey: input.idempotencyKey,
          },
        });
        await transaction.email.createMany({
          data: emailRows.map((email) => ({ ...email, campaignId: campaign.id })),
        });

        return transaction.campaign.findUniqueOrThrow({
          where: { id: campaign.id },
          include: campaignWithEmails,
        });
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const winner = await this.#findCampaign(input.userId, input.idempotencyKey);
        if (winner) return winner;
      }
      throw error;
    }
  }

  #findCampaign(userId: string, idempotencyKey: string): Promise<CampaignWithEmails | null> {
    return this.#prisma.campaign.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
      include: campaignWithEmails,
    });
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function summarizeCampaign(campaign: CampaignWithEmails): ScheduleCampaignResult {
  const first = campaign.emails[0];
  const last = campaign.emails.at(-1);
  if (!first || !last) throw new Error(`Campaign ${campaign.id} has no Emails`);

  return {
    campaignId: campaign.id,
    totalRecipients: campaign.totalRecipients,
    startAt: campaign.startAt,
    firstScheduledAt: first.scheduledAt,
    lastScheduledAt: last.scheduledAt,
  };
}

function isSameSchedulingIntent(
  campaign: CampaignWithEmails,
  input: ValidatedScheduleCampaignInput,
): boolean {
  return (
    campaign.senderId === input.senderId &&
    campaign.subject === input.subject &&
    campaign.body === input.body &&
    campaign.startAt.getTime() === input.startAt.getTime() &&
    campaign.delayMs === input.delayMs &&
    campaign.hourlyLimit === input.hourlyLimit &&
    campaign.emails.length === input.recipients.length &&
    campaign.emails.every((email, index) => email.recipientEmail === input.recipients[index])
  );
}
