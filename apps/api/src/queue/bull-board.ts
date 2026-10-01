import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import type { Router } from 'express';

import type { EmailQueue } from './email-queue.js';

export const BULL_BOARD_PATH = '/admin/queues' as const;

export function createBullBoardRouter(queue: EmailQueue): Router {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(BULL_BOARD_PATH);
  createBullBoard({
    queues: [new BullMQAdapter(queue)],
    serverAdapter,
  });

  return serverAdapter.getRouter() as Router;
}
