import { parseWorkerConfig } from './config/env.js';
import { loadRootEnvironment } from './config/load-env.js';
import { createLogger } from './config/logger.js';
import { createPrismaClient } from './config/prisma.js';
import { createEmailWorker } from './email-worker.js';
import { ShutdownManager } from './lifecycle.js';
import { EmailProcessor } from './processors/email-processor.js';
import { createLimiterRedisClient, RedisSendPermitGate } from './rate-limit/send-permit.js';
import { createRecoveryQueue, QueueReconciler } from './reconciliation/queue-reconciler.js';
import { EtherealEmailSender, getEtherealAccounts } from './smtp/ethereal-email-sender.js';

loadRootEnvironment();

const config = parseWorkerConfig(process.env);
const logger = createLogger(config);
const prisma = createPrismaClient(config.DATABASE_URL);
const elasticsearch = createElasticsearchClient(config);
const emailSearch = new EmailSearchService({ client: elasticsearch, prisma });
const emailSender = new EtherealEmailSender(getEtherealAccounts(config));
const limiterRedis = createLimiterRedisClient(config.REDIS_URL);
const recoveryQueue = createRecoveryQueue(config.REDIS_URL);
const sendPermitGate = new RedisSendPermitGate(limiterRedis);
const shutdownManager = new ShutdownManager();

// Later registrations close first. The Worker is registered after startup reconciliation.
shutdownManager.register(() => emailSender.close());
shutdownManager.register(() => prisma.$disconnect());
shutdownManager.register(() => elasticsearch.close());
shutdownManager.register(async () => {
  await limiterRedis.quit();
});
shutdownManager.register(() => recoveryQueue.close());

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Worker shutdown started');

  try {
    await shutdownManager.shutdown();
    logger.info('Worker shutdown complete');
  } catch (error) {
    logger.error({ error }, 'Worker shutdown failed');
    process.exitCode = 1;
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

try {
  await prisma.$connect();
  await limiterRedis.ping();
  await recoveryQueue.waitUntilReady();

  const reconciliation = await new QueueReconciler({
    prisma,
    queue: recoveryQueue,
    logger,
  }).reconcile();
  logger.info({ reconciliation }, 'Startup queue reconciliation finished');

  const processor = new EmailProcessor({
    prisma,
    emailSender,
    sendPermitGate,
    platformLimits: {
      minSendDelayMs: config.MIN_SEND_DELAY_MS,
      maxEmailsPerHourPerSender: config.MAX_EMAILS_PER_HOUR_PER_SENDER,
    },
    logger,
    searchProjection: emailSearch,
  });
  const worker = createEmailWorker({
    redisUrl: config.REDIS_URL,
    concurrency: config.WORKER_CONCURRENCY,
    processor,
    logger,
  });
  shutdownManager.register(() => worker.close());
  await worker.waitUntilReady();
  logger.info({ concurrency: config.WORKER_CONCURRENCY }, 'Email Worker ready and consuming jobs');
} catch (error) {
  logger.error({ error }, 'Email Worker failed to start');
  await shutdownManager.shutdown();
  throw error;
}
import { createElasticsearchClient, EmailSearchService } from '@reachinbox/search';
