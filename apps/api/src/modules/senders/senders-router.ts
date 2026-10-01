import type { PrismaClient } from '@prisma/client';
import type { SenderListResponse } from '@reachinbox/shared/contracts';
import { Router, type RequestHandler } from 'express';

import { requireAuthenticatedPrincipal } from '../../middleware/authenticated-principal.js';

export function createSendersRouter(options: {
  prisma: Pick<PrismaClient, 'sender'>;
  authenticate?: RequestHandler | undefined;
}): Router {
  const router = Router();
  if (options.authenticate) router.use(options.authenticate);
  router.use(requireAuthenticatedPrincipal);

  router.get('/', async (_request, response, next) => {
    try {
      const items = await options.prisma.sender.findMany({
        where: { userId: response.locals.principal!.userId, active: true },
        select: { id: true, fromName: true, fromEmail: true, active: true },
        orderBy: [{ fromName: 'asc' }, { id: 'asc' }],
      });
      response.status(200).json({
        items: items.map((sender) => ({ ...sender, active: true as const })),
      } satisfies SenderListResponse);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
