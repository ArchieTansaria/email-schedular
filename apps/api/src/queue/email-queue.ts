import {
  EMAIL_QUEUE_NAME,
  SEND_EMAIL_JOB_NAME,
  makeEmailJobId,
  type SendEmailJobData,
} from '@reachinbox/shared/queue';
import { Queue, type ConnectionOptions, type Job } from 'bullmq';

export type EmailQueueJob = Job<SendEmailJobData, void, typeof SEND_EMAIL_JOB_NAME>;
export type EmailQueue = Queue<EmailQueueJob>;

export interface EnqueueEmailJobInput {
  emailId: string;
  bullJobId: string;
  scheduledAt: Date;
}

interface QueueLogger {
  error(bindings: Record<string, unknown>, message: string): void;
}

export interface EmailQueueProducerOptions {
  redisUrl: string;
  logger: QueueLogger;
  prefix?: string;
}

export function calculateJobDelay(scheduledAt: Date, now: Date = new Date()): number {
  return Math.max(0, scheduledAt.getTime() - now.getTime());
}

export function createProducerConnectionOptions(redisUrl: string): ConnectionOptions {
  return {
    url: redisUrl,
    connectTimeout: 3_000,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
  };
}

export class EmailQueueProducer {
  readonly queue: EmailQueue;
  readonly #logger: QueueLogger;
  readonly #onError: (error: Error) => void;

  constructor({ redisUrl, logger, prefix }: EmailQueueProducerOptions) {
    this.#logger = logger;
    this.queue = new Queue<EmailQueueJob>(EMAIL_QUEUE_NAME, {
      connection: createProducerConnectionOptions(redisUrl),
      skipWaitingForReady: true,
      ...(prefix ? { prefix } : {}),
    });
    this.#onError = (error) => {
      this.#logger.error({ error, queue: EMAIL_QUEUE_NAME }, 'Email queue error');
    };
    this.queue.on('error', this.#onError);
  }

  waitUntilReady(): Promise<void> {
    return this.queue.waitUntilReady();
  }

  enqueueEmailJob(input: EnqueueEmailJobInput, now: Date = new Date()): Promise<EmailQueueJob> {
    assertDeterministicJobId(input);

    return this.queue.add(
      SEND_EMAIL_JOB_NAME,
      { emailId: input.emailId },
      {
        jobId: input.bullJobId,
        delay: calculateJobDelay(input.scheduledAt, now),
      },
    );
  }

  enqueueEmailJobsBulk(
    inputs: readonly EnqueueEmailJobInput[],
    now: Date = new Date(),
  ): Promise<EmailQueueJob[]> {
    for (const input of inputs) assertDeterministicJobId(input);

    return this.queue.addBulk(
      inputs.map((input) => ({
        name: SEND_EMAIL_JOB_NAME,
        data: { emailId: input.emailId },
        opts: {
          jobId: input.bullJobId,
          delay: calculateJobDelay(input.scheduledAt, now),
        },
      })),
    );
  }

  async close(): Promise<void> {
    try {
      await this.queue.close();
    } finally {
      this.queue.off('error', this.#onError);
    }
  }
}

function assertDeterministicJobId({ emailId, bullJobId }: EnqueueEmailJobInput): void {
  const expectedJobId = makeEmailJobId(emailId);

  if (bullJobId !== expectedJobId) {
    throw new Error(`bullJobId must equal ${expectedJobId}`);
  }
}
