import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';
import { Router, type Request, type RequestHandler } from 'express';

import { requireAuthenticatedPrincipal } from '../../middleware/authenticated-principal.js';
import type { GoogleOAuthProvider } from './google-oauth.js';
import { SESSION_COOKIE_NAME } from './session.js';

const OAUTH_ATTEMPT_TTL_MS = 10 * 60 * 1_000;

interface AuthLogger {
  error(bindings: Record<string, unknown>, message: string): void;
}

export function createAuthRouter(options: {
  prisma: Pick<PrismaClient, 'user'>;
  google: GoogleOAuthProvider;
  authenticate: RequestHandler;
  frontendUrl: string;
  production: boolean;
  logger: AuthLogger;
  now?: () => number;
}): Router {
  const router = Router();
  const now = options.now ?? Date.now;

  router.get('/google', async (request, response, next) => {
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    request.session.googleOAuthAttempt = { state, nonce, createdAt: now() };

    try {
      await saveSession(request);
      response.redirect(302, options.google.generateAuthorizationUrl({ state, nonce }));
    } catch (error) {
      next(error);
    }
  });

  router.get('/google/callback', async (request, response, next) => {
    const state = singleQueryValue(request.query.state);
    const attempt = request.session.googleOAuthAttempt;
    if (!state || !attempt || !safeEqual(state, attempt.state)) {
      response.status(400).json(oauthError('INVALID_OAUTH_STATE', 'Google OAuth state is invalid'));
      return;
    }

    delete request.session.googleOAuthAttempt;
    try {
      await saveSession(request);
    } catch (error) {
      next(error);
      return;
    }

    if (now() - attempt.createdAt > OAUTH_ATTEMPT_TTL_MS) {
      response
        .status(400)
        .json(oauthError('INVALID_OAUTH_STATE', 'Google OAuth state has expired'));
      return;
    }

    const providerError = singleQueryValue(request.query.error);
    const code = singleQueryValue(request.query.code);
    if (providerError || !code) {
      response
        .status(400)
        .json(oauthError('GOOGLE_OAUTH_DENIED', 'Google authentication was not completed'));
      return;
    }

    try {
      const identity = await options.google.exchangeCode({
        code,
        expectedNonce: attempt.nonce,
      });
      const user = await options.prisma.user.upsert({
        where: { googleSub: identity.sub },
        create: {
          googleSub: identity.sub,
          email: identity.email,
          name: identity.name,
          avatarUrl: identity.avatarUrl,
        },
        update: {
          email: identity.email,
          name: identity.name,
          avatarUrl: identity.avatarUrl,
        },
        select: { id: true },
      });

      await regenerateSession(request);
      request.session.userId = user.id;
      await saveSession(request);
      response.redirect(302, options.frontendUrl);
    } catch (error) {
      options.logger.error(
        {
          errorName: error instanceof Error ? error.name : 'UnknownError',
          operation: 'google-oauth-callback',
        },
        'Google OAuth callback failed',
      );
      response
        .status(502)
        .json(oauthError('GOOGLE_OAUTH_FAILED', 'Google authentication could not be completed'));
    }
  });

  router.get(
    '/me',
    options.authenticate,
    requireAuthenticatedPrincipal,
    async (_request, response) => {
      const user = await options.prisma.user.findUniqueOrThrow({
        where: { id: response.locals.principal!.userId },
        select: { id: true, email: true, name: true, avatarUrl: true },
      });
      response.status(200).json(user);
    },
  );

  router.post('/logout', (request, response, next) => {
    request.session.destroy((error) => {
      if (error) {
        next(error);
        return;
      }
      response.clearCookie(SESSION_COOKIE_NAME, {
        httpOnly: true,
        sameSite: 'lax',
        secure: options.production,
        path: '/',
      });
      response.status(200).json({ authenticated: false });
    });
  });

  return router;
}

function singleQueryValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function saveSession(request: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    request.session.save((error) => (error ? reject(error) : resolve()));
  });
}

function regenerateSession(request: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    request.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
}

function oauthError(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}
