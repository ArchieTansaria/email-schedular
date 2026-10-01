import { createHealthResponse } from '@reachinbox/shared/contracts';
import express, { type Express, type RequestHandler } from 'express';

import type { CampaignScheduler } from './modules/campaigns/campaign-scheduler.js';
import type { EmailSearchService } from '@reachinbox/search';
import {
  createSchedulingRouter,
  schedulingUploadErrorHandler,
} from './modules/campaigns/scheduling-router.js';
import { BULL_BOARD_PATH, createBullBoardRouter } from './queue/bull-board.js';
import { createEmailSearchRouter } from './modules/emails/search-router.js';
import type { EmailQueue } from './queue/email-queue.js';

export interface AppDependencies {
  emailQueue?: EmailQueue;
  campaignScheduler?: CampaignScheduler;
  emailSearch?: Pick<EmailSearchService, 'search'>;
  authenticationMiddleware?: RequestHandler | undefined;
  logger?: { error(bindings: Record<string, unknown>, message: string): void };
}

export function createApp({
  emailQueue,
  campaignScheduler,
  emailSearch,
  authenticationMiddleware,
  logger = { error: () => undefined },
}: AppDependencies = {}): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_request, response) => {
    response.status(200).json(createHealthResponse());
  });

  if (campaignScheduler) {
    app.use(
      '/api/v1/campaigns',
      createSchedulingRouter({
        scheduler: campaignScheduler,
        authenticate: authenticationMiddleware,
        logger,
      }),
    );
    app.use(schedulingUploadErrorHandler());
  }

  if (emailSearch) {
    app.use(
      '/api/v1/emails/search',
      createEmailSearchRouter({
        search: emailSearch,
        authenticate: authenticationMiddleware,
        logger,
      }),
    );
  }

  if (emailQueue) {
    app.use(BULL_BOARD_PATH, createBullBoardRouter(emailQueue));
  }

  return app;
}
