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

export function createDevelopmentPrincipalMiddleware(
  nodeEnv: string,
  userId: string | undefined,
): RequestHandler | undefined {
  if (nodeEnv === 'production' || !userId) return undefined;

  return (_request, response, next) => {
    response.locals.principal = { userId };
    next();
  };
}
