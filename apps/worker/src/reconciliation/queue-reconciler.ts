import { EmailStatus, type PrismaClient } from '@prisma/client';
import {
  EMAIL_QUEUE_NAME,
  SEND_EMAIL_JOB_NAME,
  makeEmailJobId,
  emailJobRetryOptions,
  type EmailJobRetryConfig,
  type SendEmailJobData,
} from '@reachinbox/shared/queue';
import { ErrorCode, Queue, type ConnectionOptions } from 'bullmq';

const DEFAULT_BATCH_SIZE = 250;

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
  retryConfig?: EmailJobRetryConfig;
}

export function createRecoveryQueue(redisUrl: string, prefix?: string): Queue<SendEmailJobData> {
  const connection: ConnectionOptions = {
    url: redisUrl,
    connectTimeout: 10_000,
    maxRetriesPerRequest: 1,
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
  readonly #retryConfig: EmailJobRetryConfig | undefined;

  constructor({
    prisma,
    queue,
    logger,
    batchSize = DEFAULT_BATCH_SIZE,
    now = () => new Date(),
    retryConfig,
  }: QueueReconcilerOptions) {
    this.#prisma = prisma;
    this.#queue = queue;
    this.#logger = logger;
    this.#batchSize = batchSize;
    this.#now = now;
    this.#retryConfig = retryConfig;
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

    if (job && state !== 'unknown' && state !== 'completed' && state !== 'failed') {
      report.jobsAlreadyPresent += 1;
      return;
    }

    // The scan can race with delivery or another reconciliation pass.
    const current = await this.#prisma.email.findUnique({
      where: { id: email.id },
      select: { status: true, scheduledAt: true },
    });
    if (!current || current.status !== EmailStatus.SCHEDULED) return;

    if (job && (state === 'completed' || state === 'failed')) {
      if (!report.dryRun) {
        try {
          // This checks the terminal state atomically. Never remove a job based
          // on a stale getState(): another worker may already have resumed it.
          await job.retry(state, { resetAttemptsMade: true, resetAttemptsStarted: true });
        } catch (error) {
          if (
            error instanceof Error &&
            'code' in error &&
            [ErrorCode.JobNotExist, ErrorCode.JobNotInState, ErrorCode.JobLockNotExist].includes(
              Number(error.code),
            )
          ) {
            // Another actor changed the job. A later pass repairs any remaining gap.
            report.jobsAlreadyPresent += 1;
            return;
          }
          throw error;
        }
      }
      report.terminalJobsRepaired += 1;
      report.jobsRestored += 1;
      return;
    }

    report.jobsRestored += 1;
    if (report.dryRun) return;

    await this.#queue.add(
      SEND_EMAIL_JOB_NAME,
      { emailId: email.id },
      {
        jobId,
        ...emailJobRetryOptions(this.#retryConfig),
        delay: Math.max(0, current.scheduledAt.getTime() - this.#now().getTime()),
      },
    );
  }
}
