import { resolve } from 'node:path';

import { config as loadEnvironment } from 'dotenv';

import { createElasticsearchClient, parseSearchConfig } from './config.js';
import { ensureEmailSearchIndex } from './email-search.js';

loadEnvironment({ path: resolve(import.meta.dirname, '../../../.env'), quiet: true });

const client = createElasticsearchClient(parseSearchConfig(process.env));

try {
  const outcome = await ensureEmailSearchIndex(client);
  process.stdout.write(`Elasticsearch email index ${outcome}\n`);
} finally {
  await client.close();
}
