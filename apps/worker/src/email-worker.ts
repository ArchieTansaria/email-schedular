import { EMAIL_QUEUE_NAME, type SendEmailJobData } from '@reachinbox/shared/queue';
import { Worker, type ConnectionOptions } from 'bullmq';

import type { EmailJobResult, EmailProcessor } from './processors/email-processor.js';

interface WorkerLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export interface CreateEmailWorkerOptions {
  redisUrl: string;
  concurrency: number;
  processor: EmailProcessor;
  logger: WorkerLogger;
  prefix?: string;
  workerName?: string;
}

export function createWorkerConnectionOptions(redisUrl: string): ConnectionOptions {
  return {
    url: redisUrl,
    connectTimeout: 10_000,
    maxRetriesPerRequest: null,
    retryStrategy: (attempt) => Math.min(attempt * 500, 5_000),
  };
}

export function createEmailWorker({
  redisUrl,
  concurrency,
  processor,
  logger,
  prefix,
  workerName,
}: CreateEmailWorkerOptions): Worker<SendEmailJobData, EmailJobResult> {
  const worker = new Worker<SendEmailJobData, EmailJobResult>(
    EMAIL_QUEUE_NAME,
    (job) => processor.process(job),
    {
      connection: createWorkerConnectionOptions(redisUrl),
      concurrency,
      ...(prefix ? { prefix } : {}),
      ...(workerName ? { name: workerName } : {}),
    },
  );

  worker.on('completed', (job, result) => {
    logger.info(
      { jobId: job.id, emailId: job.data.emailId, outcome: result.outcome },
      'Email job completed',
    );
  });
  worker.on('failed', (job, error) => {
    logger.error({ error, jobId: job?.id, emailId: job?.data.emailId }, 'Email job failed');
  });
  worker.on('stalled', (jobId, previousState) => {
    logger.warn({ jobId, previousState }, 'Email job stalled');
  });
  worker.on('error', (error) => {
    logger.error({ error, queue: EMAIL_QUEUE_NAME }, 'Email Worker error');
  });

  return worker;
}
