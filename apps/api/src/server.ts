import { createServer } from 'node:http';

import { createElasticsearchClient, EmailSearchService } from '@reachinbox/search';
import {
  FetchSlackClient,
  SecretCipher,
  SlackIntegrationService,
  SlackOAuthStateStore,
} from '@reachinbox/slack';
import { Redis } from 'ioredis';

import { createApp } from './app.js';
import { parseApiConfig } from './config/env.js';
import { loadRootEnvironment } from './config/load-env.js';
import { createLogger } from './config/logger.js';
import { createPrismaClient } from './config/prisma.js';
import { ShutdownManager } from './lifecycle.js';
import { createDevelopmentPrincipalMiddleware } from './middleware/authenticated-principal.js';
import { CampaignScheduler } from './modules/campaigns/campaign-scheduler.js';
import { createSlackRouter } from './modules/slack/slack-router.js';
import { EmailQueueProducer } from './queue/email-queue.js';

loadRootEnvironment();

const config = parseApiConfig(process.env);
const logger = createLogger(config);
const prisma = createPrismaClient(config.DATABASE_URL);
const elasticsearch = createElasticsearchClient(config);
const emailSearch = new EmailSearchService({ client: elasticsearch, prisma });
const emailQueueProducer = new EmailQueueProducer({ redisUrl: config.REDIS_URL, logger });
const campaignScheduler = new CampaignScheduler({
  prisma,
  producer: emailQueueProducer,
  limits: config,
  logger,
  searchProjection: emailSearch,
});
const authenticationMiddleware = createDevelopmentPrincipalMiddleware(
  config.NODE_ENV,
  config.DEV_AUTH_USER_ID,
);
let slackRedis: Redis | undefined;
let slackRouter;
if (config.SLACK_CLIENT_ID && config.SLACK_CLIENT_SECRET && config.SLACK_CALLBACK_URL) {
  slackRedis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
  const slackClient = new FetchSlackClient({
    clientId: config.SLACK_CLIENT_ID,
    clientSecret: config.SLACK_CLIENT_SECRET,
    redirectUri: config.SLACK_CALLBACK_URL,
  });
  slackRouter = createSlackRouter({
    authenticate: authenticationMiddleware,
    stateStore: new SlackOAuthStateStore(slackRedis),
    slackClient,
    integrations: new SlackIntegrationService({
      prisma,
      cipher: new SecretCipher(config.APP_ENCRYPTION_KEY),
      client: slackClient,
    }),
    clientId: config.SLACK_CLIENT_ID,
    redirectUri: config.SLACK_CALLBACK_URL,
    frontendUrl: config.FRONTEND_URL,
    logger,
  });
}
const server = createServer(
  createApp({
    emailQueue: emailQueueProducer.queue,
    campaignScheduler,
    emailSearch,
    authenticationMiddleware,
    logger,
    ...(slackRouter ? { slackRouter } : {}),
  }),
);
const shutdownManager = new ShutdownManager();

shutdownManager.register(() => emailQueueProducer.close());
shutdownManager.register(() => prisma.$disconnect());
shutdownManager.register(() => elasticsearch.close());
if (slackRedis) shutdownManager.register(() => slackRedis.quit().then(() => undefined));
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
