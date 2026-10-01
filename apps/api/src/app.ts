import { createHealthResponse } from '@reachinbox/shared/contracts';
import express, { type Express, type RequestHandler } from 'express';

import type { CampaignScheduler } from './modules/campaigns/campaign-scheduler.js';
import type { EmailSearchService } from '@reachinbox/search';
import type { Router } from 'express';
import {
  createSchedulingRouter,
  schedulingUploadErrorHandler,
} from './modules/campaigns/scheduling-router.js';
import { BULL_BOARD_PATH, createBullBoardRouter } from './queue/bull-board.js';
import { createEmailSearchRouter } from './modules/emails/search-router.js';
import type { EmailQueue } from './queue/email-queue.js';
import { requireAuthenticatedPrincipal } from './middleware/authenticated-principal.js';
import type { PrismaClient } from '@prisma/client';
import { EmailReadService } from './modules/emails/email-read-service.js';
import { createEmailReadRouter } from './modules/emails/email-read-router.js';
import { createSendersRouter } from './modules/senders/senders-router.js';

export interface AppDependencies {
  emailQueue?: EmailQueue;
  campaignScheduler?: CampaignScheduler;
  emailSearch?: Pick<EmailSearchService, 'search'>;
  sessionMiddleware?: RequestHandler;
  authenticationMiddleware?: RequestHandler | undefined;
  logger?: { error(bindings: Record<string, unknown>, message: string): void };
  slackRouter?: Router;
  authRouter?: Router;
  trustProxy?: boolean;
  prisma?: PrismaClient;
}

export function createApp({
  emailQueue,
  campaignScheduler,
  emailSearch,
  sessionMiddleware,
  authenticationMiddleware,
  logger = { error: () => undefined },
  slackRouter,
  authRouter,
  trustProxy = false,
  prisma,
}: AppDependencies = {}): Express {
  const app = express();

  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', 1);
  if (sessionMiddleware) {
    app.use((request, response, next) => {
      sessionMiddleware(request, response, (error?: unknown) => {
        if (!error) {
          next();
          return;
        }
        logger.error(
          {
            errorName: error instanceof Error ? error.name : 'UnknownError',
            operation: 'session-load',
          },
          'Session infrastructure unavailable',
        );
        response.status(503).json({
          error: { code: 'AUTH_UNAVAILABLE', message: 'Authentication is temporarily unavailable' },
        });
      });
    });
  }
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_request, response) => {
    response.status(200).json(createHealthResponse());
  });

  if (authRouter) app.use('/api/v1/auth', authRouter);

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

  if (prisma) {
    app.use(
      '/api/v1/senders',
      createSendersRouter({ prisma, authenticate: authenticationMiddleware }),
    );
    app.use(
      '/api/v1/emails',
      createEmailReadRouter({
        emails: new EmailReadService(prisma),
        authenticate: authenticationMiddleware,
      }),
    );
  }

  if (emailQueue) {
    app.use(
      BULL_BOARD_PATH,
      ...(authenticationMiddleware ? [authenticationMiddleware] : []),
      requireAuthenticatedPrincipal,
      createBullBoardRouter(emailQueue),
    );
  }

  if (slackRouter) app.use('/api/v1/integrations/slack', slackRouter);

  return app;
}
