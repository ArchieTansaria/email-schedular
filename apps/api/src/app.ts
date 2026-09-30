import { createHealthResponse } from '@reachinbox/shared/contracts';
import express, { type Express } from 'express';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_request, response) => {
    response.status(200).json(createHealthResponse());
  });

  return app;
}
