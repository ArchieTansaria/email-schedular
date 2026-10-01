import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import { requireAuthenticatedPrincipal } from '../../middleware/authenticated-principal.js';
import { InvalidEmailCursorError } from './email-read-service.js';
import type { EmailReadService } from './email-read-service.js';

const listQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const detailParamsSchema = z.object({ id: z.uuid() });

export function createEmailReadRouter(options: {
  emails: EmailReadService;
  authenticate?: RequestHandler | undefined;
}): Router {
  const router = Router();
  if (options.authenticate) router.use(options.authenticate);
  router.use(requireAuthenticatedPrincipal);

  router.get('/scheduled', listHandler(options.emails, 'scheduled'));
  router.get('/sent', listHandler(options.emails, 'sent'));
  router.get('/:id', async (request, response, next) => {
    const params = detailParamsSchema.safeParse(request.params);
    if (!params.success) {
      response.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid email ID' } });
      return;
    }
    try {
      const email = await options.emails.findDetail(
        response.locals.principal!.userId,
        params.data.id,
      );
      if (!email) {
        response
          .status(404)
          .json({ error: { code: 'EMAIL_NOT_FOUND', message: 'Email not found' } });
        return;
      }
      response.status(200).json(email);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function listHandler(emails: EmailReadService, mode: 'scheduled' | 'sent'): RequestHandler {
  return async (request, response, next) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) {
      response.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'Invalid pagination parameters',
          issues: query.error.issues,
        },
      });
      return;
    }
    try {
      const input = { userId: response.locals.principal!.userId, ...query.data };
      const result =
        mode === 'scheduled' ? await emails.listScheduled(input) : await emails.listSent(input);
      response.status(200).json(result);
    } catch (error) {
      if (error instanceof InvalidEmailCursorError) {
        response.status(400).json({ error: { code: 'BAD_REQUEST', message: error.message } });
        return;
      }
      next(error);
    }
  };
}
