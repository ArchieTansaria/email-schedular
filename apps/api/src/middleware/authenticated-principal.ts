import type { PrismaClient } from '@prisma/client';
import type { RequestHandler } from 'express';

export interface AuthenticatedPrincipal {
  userId: string;
}

declare global {
  // Express exposes Locals through a global namespace specifically for declaration merging.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      principal?: AuthenticatedPrincipal;
    }
  }
}

export function createSessionPrincipalMiddleware(
  prisma: Pick<PrismaClient, 'user'>,
): RequestHandler {
  return async (request, response, next) => {
    const userId = request.session.userId;
    if (!userId) {
      next();
      return;
    }

    try {
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (user) response.locals.principal = { userId: user.id };
      next();
    } catch (error) {
      next(error);
    }
  };
}

export const requireAuthenticatedPrincipal: RequestHandler = (_request, response, next) => {
  if (response.locals.principal) {
    next();
    return;
  }

  response
    .status(401)
    .json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
};
