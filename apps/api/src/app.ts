import { createHealthResponse } from '@reachinbox/shared/contracts';
import express, { type Express } from 'express';

import { BULL_BOARD_PATH, createBullBoardRouter } from './queue/bull-board.js';
import type { EmailQueue } from './queue/email-queue.js';

export interface AppDependencies {
  emailQueue?: EmailQueue;
}

export function createApp({ emailQueue }: AppDependencies = {}): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_request, response) => {
    response.status(200).json(createHealthResponse());
  });

  if (emailQueue) {
    app.use(BULL_BOARD_PATH, createBullBoardRouter(emailQueue));
  }

  return app;
}
