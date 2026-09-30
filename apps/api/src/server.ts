import { createServer } from 'node:http';

import { createApp } from './app.js';
import { parseApiConfig } from './config/env.js';
import { loadRootEnvironment } from './config/load-env.js';
import { createLogger } from './config/logger.js';
import { ShutdownManager } from './lifecycle.js';

loadRootEnvironment();

const config = parseApiConfig(process.env);
const logger = createLogger(config);
const server = createServer(createApp());
const shutdownManager = new ShutdownManager();

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
