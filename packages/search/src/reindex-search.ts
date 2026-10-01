import { resolve } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { config as loadEnvironment } from 'dotenv';

import { createElasticsearchClient, parseReindexConfig } from './config.js';
import { EmailSearchService } from './email-search.js';
import { reindexEmails } from './reindex.js';

loadEnvironment({ path: resolve(import.meta.dirname, '../../../.env'), quiet: true });

const config = parseReindexConfig(process.env);
const prisma = new PrismaClient({ datasourceUrl: config.DATABASE_URL });
const client = createElasticsearchClient(config);
const search = new EmailSearchService({ client, prisma });

try {
  const report = await reindexEmails({
    prisma,
    search,
    logger: { error: (bindings, message) => console.error(message, bindings) },
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.failures > 0) process.exitCode = 1;
} finally {
  await Promise.all([prisma.$disconnect(), client.close()]);
}
