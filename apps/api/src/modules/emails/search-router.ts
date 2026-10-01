import { EmailStatus } from '@prisma/client';
import type { EmailSearchService } from '@reachinbox/search';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  status: z.enum(EmailStatus).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

interface SearchLogger {
  error(bindings: Record<string, unknown>, message: string): void;
}

export function createEmailSearchRouter(options: {
  search: Pick<EmailSearchService, 'search'>;
  authenticate?: RequestHandler | undefined;
  logger: SearchLogger;
}): Router {
  const router = Router();

  if (options.authenticate) router.use(options.authenticate);

  router.get('/', async (request, response) => {
    const principal = response.locals.principal;
    if (!principal) {
      response
        .status(401)
        .json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
      return;
    }

    const parsed = searchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: 'BAD_REQUEST',
          message: 'Invalid search query',
          issues: parsed.error.issues,
        },
      });
      return;
    }

    try {
      const result = await options.search.search({ userId: principal.userId, ...parsed.data });
      response.status(200).json(result);
    } catch (error) {
      options.logger.error(
        { error, userId: principal.userId, operation: 'search-emails' },
        'Elasticsearch email search failed',
      );
      response.status(503).json({
        error: { code: 'SEARCH_UNAVAILABLE', message: 'Email search is temporarily unavailable' },
      });
    }
  });

  return router;
}
