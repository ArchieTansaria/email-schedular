import pino, { type Logger } from 'pino';

import type { WorkerConfig } from './env.js';

export function createLogger(config: Pick<WorkerConfig, 'LOG_LEVEL'>): Logger {
  return pino({
    level: config.LOG_LEVEL,
    base: { service: 'worker' },
  });
}
