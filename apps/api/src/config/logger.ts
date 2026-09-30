import pino, { type Logger } from 'pino';

import type { ApiConfig } from './env.js';

export function createLogger(config: Pick<ApiConfig, 'LOG_LEVEL'>): Logger {
  return pino({
    level: config.LOG_LEVEL,
    base: { service: 'api' },
    redact: ['req.headers.authorization', 'req.headers.cookie'],
  });
}
