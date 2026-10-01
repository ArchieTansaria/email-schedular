import pino, { type Logger } from 'pino';

import type { WorkerConfig } from './env.js';

export function createLogger(config: Pick<WorkerConfig, 'LOG_LEVEL'>): Logger {
  return pino({
    level: config.LOG_LEVEL,
    base: { service: 'worker' },
    redact: [
      '*.password',
      '*.pass',
      'error.config.auth.pass',
      'error.options.auth.pass',
      'error.cause.config.auth.pass',
      'error.cause.options.auth.pass',
    ],
  });
}
