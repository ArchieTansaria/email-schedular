import { EmailStatus, type PrismaClient } from '@prisma/client';
import {
  EMAIL_QUEUE_NAME,
  SEND_EMAIL_JOB_NAME,
  makeEmailJobId,
  type SendEmailJobData,
} from '@reachinbox/shared/queue';
import { Queue, type ConnectionOptions } from 'bullmq';

const DEFAULT_BATCH_SIZE = 250;
const TERMINAL_QUEUE_STATES = new Set(['completed', 'failed']);

export interface ReconciliationReport {
  dryRun: boolean;
  scheduledInspected: number;
  jobsAlreadyPresent: number;
  jobsRestored: number;
  terminalJobsRepaired: number;
  processingObserved: number;
}

interface ReconciliationLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
}

export interface QueueReconcilerOptions {
  prisma: PrismaClient;
  queue: Queue<SendEmailJobData>;
  logger: ReconciliationLogger;
  batchSize?: number;
  now?: () => Date;
}

export function createRecoveryQueue(redisUrl: string, prefix?: string): Queue<SendEmailJobData> {
  const connection: ConnectionOptions = {
    url: redisUrl,
    connectTimeout: 10_000,
    maxRetriesPerRequest: null,
    retryStrategy: (attempt) => Math.min(attempt * 500, 5_000),
  };

  return new Queue<SendEmailJobData>(EMAIL_QUEUE_NAME, {
    connection,
    ...(prefix ? { prefix } : {}),
  });
}

export class QueueReconciler {
  readonly #prisma: PrismaClient;
  readonly #queue: Queue<SendEmailJobData>;
  readonly #logger: ReconciliationLogger;
  readonly #batchSize: number;
  readonly #now: () => Date;

  constructor({
    prisma,
    queue,
    logger,
    batchSize = DEFAULT_BATCH_SIZE,
    now = () => new Date(),
  }: QueueReconcilerOptions) {
    this.#prisma = prisma;
    this.#queue = queue;
    this.#logger = logger;
    this.#batchSize = batchSize;
    this.#now = now;
  }

  async reconcile({ dryRun = false }: { dryRun?: boolean } = {}): Promise<ReconciliationReport> {
    const report: ReconciliationReport = {
      dryRun,
      scheduledInspected: 0,
      jobsAlreadyPresent: 0,
      jobsRestored: 0,
      terminalJobsRepaired: 0,
      processingObserved: await this.#prisma.email.count({
        where: { status: EmailStatus.PROCESSING },
      }),
    };

    let cursorId: string | undefined;
    while (true) {
      const emails = await this.#prisma.email.findMany({
        where: {
          status: EmailStatus.SCHEDULED,
          ...(cursorId ? { id: { gt: cursorId } } : {}),
        },
        select: { id: true, scheduledAt: true },
        orderBy: { id: 'asc' },
        take: this.#batchSize,
      });
      if (emails.length === 0) break;

      for (const email of emails) {
        report.scheduledInspected += 1;
        await this.#reconcileEmail(email, report);
      }

      cursorId = emails.at(-1)?.id;
      if (emails.length < this.#batchSize) break;
    }

    this.#logger.info({ report }, 'Email queue reconciliation complete');
    if (report.processingObserved > 0) {
      this.#logger.warn(
        { count: report.processingObserved },
        'PROCESSING Emails require manual review and were not modified',
      );
    }
    return report;
  }

  async #reconcileEmail(
    email: { id: string; scheduledAt: Date },
    report: ReconciliationReport,
  ): Promise<void> {
    const jobId = makeEmailJobId(email.id);
    const job = await this.#queue.getJob(jobId);
    const state = job ? await job.getState() : 'unknown';

    if (job && state !== 'unknown' && !TERMINAL_QUEUE_STATES.has(state)) {
      report.jobsAlreadyPresent += 1;
      return;
    }

    if (job && TERMINAL_QUEUE_STATES.has(state)) {
      report.terminalJobsRepaired += 1;
      if (!report.dryRun) await job.remove();
    }

    report.jobsRestored += 1;
    if (report.dryRun) return;

    await this.#queue.add(
      SEND_EMAIL_JOB_NAME,
      { emailId: email.id },
      {
        jobId,
        delay: Math.max(0, email.scheduledAt.getTime() - this.#now().getTime()),
      },
    );
  }
}
