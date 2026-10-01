import { parseWorkerInfrastructureConfig } from './config/env.js';
import { loadRootEnvironment } from './config/load-env.js';
import { createLogger } from './config/logger.js';
import { createPrismaClient } from './config/prisma.js';
import { createRecoveryQueue, QueueReconciler } from './reconciliation/queue-reconciler.js';

loadRootEnvironment();

const config = parseWorkerInfrastructureConfig(process.env);
const logger = createLogger(config);
const prisma = createPrismaClient(config.DATABASE_URL);
const queue = createRecoveryQueue(config.REDIS_URL);
const reconciler = new QueueReconciler({ prisma, queue, logger });
const dryRun = process.argv.includes('--dry-run');

try {
  await queue.waitUntilReady();
  const report = await reconciler.reconcile({ dryRun });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await queue.close();
  await prisma.$disconnect();
}
