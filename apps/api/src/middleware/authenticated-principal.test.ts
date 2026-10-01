import { randomUUID } from 'node:crypto';

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createDevelopmentPrincipalMiddleware } from './authenticated-principal.js';

describe('development principal middleware', () => {
  it('injects only the configured non-production principal', async () => {
    const userId = randomUUID();
    const app = express();
    app.use(createDevelopmentPrincipalMiddleware('development', userId)!);
    app.get('/', (_request, response) => response.json(response.locals.principal));

    await request(app).get('/').expect(200, { userId });
  });

  it('cannot activate in production', () => {
    expect(createDevelopmentPrincipalMiddleware('production', randomUUID())).toBeUndefined();
  });
});
