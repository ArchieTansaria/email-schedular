import { randomUUID } from 'node:crypto';

import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createSessionPrincipalMiddleware } from './authenticated-principal.js';

describe('session principal middleware', () => {
  it('adapts a valid server-side session user into the established principal contract', async () => {
    const userId = randomUUID();
    const findUnique = vi.fn().mockResolvedValue({ id: userId });
    const prisma = {
      user: { findUnique },
    } as never;
    const app = express();
    app.use(
      session({
        secret: 'test-session-secret-that-is-long-enough',
        resave: false,
        saveUninitialized: false,
      }),
    );
    app.get('/login', (req, res) => {
      req.session.userId = userId;
      res.sendStatus(204);
    });
    app.use(createSessionPrincipalMiddleware(prisma));
    app.get('/principal', (_request, response) => response.json(response.locals.principal));

    const agent = request.agent(app);
    await agent.get('/login').expect(204);
    await agent.get('/principal').expect(200, { userId });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: userId },
      select: { id: true },
    });
  });

  it('does not create an identity without a session user', async () => {
    const app = express();
    app.use(
      session({
        secret: 'test-session-secret-that-is-long-enough',
        resave: false,
        saveUninitialized: false,
      }),
    );
    app.use(
      createSessionPrincipalMiddleware({
        user: { findUnique: vi.fn().mockResolvedValue(null) },
      } as never),
    );
    app.get('/', (_request, response) => response.json(response.locals.principal ?? null));

    await request(app).get('/').expect(200, null);
  });
});
