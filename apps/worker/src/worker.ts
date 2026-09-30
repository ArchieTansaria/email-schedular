import { parseWorkerConfig } from './config/env.js';
import { loadRootEnvironment } from './config/load-env.js';
import { createLogger } from './config/logger.js';
import { ShutdownManager } from './lifecycle.js';

loadRootEnvironment();

const config = parseWorkerConfig(process.env);
const logger = createLogger(config);
const shutdownManager = new ShutdownManager();

// A referenced timer keeps the Phase 0 process alive until BullMQ owns the event loop in Phase 1.
const keepAliveTimer = setInterval(() => undefined, 60_000);
shutdownManager.register(() => clearInterval(keepAliveTimer));

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

logger.info(
  { concurrency: config.WORKER_CONCURRENCY },
  'Worker runtime ready; queue processing is pending Phase 1',
);
