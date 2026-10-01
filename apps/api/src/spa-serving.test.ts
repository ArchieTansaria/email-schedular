import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

let webDistPath: string;

beforeAll(async () => {
  webDistPath = await mkdtemp(join(tmpdir(), 'reachinbox-spa-'));
  await writeFile(join(webDistPath, 'index.html'), '<!doctype html><div id="root">SPA shell</div>');
  await writeFile(join(webDistPath, 'asset.txt'), 'static asset');
});

afterAll(async () => {
  await rm(webDistPath, { recursive: true, force: true });
});

describe('production SPA serving', () => {
  const app = () => createApp({ webDistPath });

  it.each(['/', '/login', '/compose', '/emails/00000000-0000-4000-8000-000000000001'])(
    'serves the React shell for %s',
    async (path) => {
      const response = await request(app()).get(path).set('Accept', 'text/html').expect(200);
      expect(response.text).toContain('SPA shell');
    },
  );

  it('serves built static assets', async () => {
    await request(app()).get('/asset.txt').expect(200, 'static asset');
  });

  it('never lets the SPA fallback swallow API or admin paths', async () => {
    const api = await request(app()).get('/api/not-real').set('Accept', 'text/html').expect(404);
    expect(api.type).toMatch(/json/);
    expect(api.body).toEqual({ error: { code: 'NOT_FOUND', message: 'API route not found' } });

    const admin = await request(app())
      .get('/admin/not-real')
      .set('Accept', 'text/html')
      .expect(404);
    expect(admin.text).not.toContain('SPA shell');
  });
});
