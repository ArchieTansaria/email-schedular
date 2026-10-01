import { createServer } from 'node:http';

import { createApp } from './app.js';
import { parseApiConfig } from './config/env.js';
import { loadRootEnvironment } from './config/load-env.js';
import { createLogger } from './config/logger.js';
import { createPrismaClient } from './config/prisma.js';
import { ShutdownManager } from './lifecycle.js';
import { createDevelopmentPrincipalMiddleware } from './middleware/authenticated-principal.js';
import { CampaignScheduler } from './modules/campaigns/campaign-scheduler.js';
import { EmailQueueProducer } from './queue/email-queue.js';

loadRootEnvironment();

const config = parseApiConfig(process.env);
const logger = createLogger(config);
const prisma = createPrismaClient(config.DATABASE_URL);
const emailQueueProducer = new EmailQueueProducer({ redisUrl: config.REDIS_URL, logger });
const campaignScheduler = new CampaignScheduler({
  prisma,
  producer: emailQueueProducer,
  limits: config,
  logger,
});
const authenticationMiddleware = createDevelopmentPrincipalMiddleware(
  config.NODE_ENV,
  config.DEV_AUTH_USER_ID,
);
const server = createServer(
  createApp({
    emailQueue: emailQueueProducer.queue,
    campaignScheduler,
    authenticationMiddleware,
    logger,
  }),
);
const shutdownManager = new ShutdownManager();

shutdownManager.register(() => emailQueueProducer.close());
shutdownManager.register(() => prisma.$disconnect());
shutdownManager.register(
  () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    }),
);

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'API shutdown started');

  try {
    await shutdownManager.shutdown();
    logger.info('API shutdown complete');
  } catch (error) {
    logger.error({ error }, 'API shutdown failed');
    process.exitCode = 1;
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

server.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'API listening');
});
