import type { PrismaClient } from '@prisma/client';

import { buildEmailSearchDocument, emailProjectionSelect } from './document.js';
import type { EmailSearchService } from './email-search.js';

export interface ReindexReport {
  rowsRead: number;
  indexed: number;
  failures: number;
}

interface ReindexLogger {
  error(bindings: Record<string, unknown>, message: string): void;
}

export async function reindexEmails(options: {
  prisma: PrismaClient;
  search: EmailSearchService;
  batchSize?: number;
  refresh?: boolean | 'wait_for';
  logger?: ReindexLogger;
}): Promise<ReindexReport> {
  const batchSize = options.batchSize ?? 500;
  const report: ReindexReport = { rowsRead: 0, indexed: 0, failures: 0 };
  let cursorId: string | undefined;

  await options.search.ensureIndex();

  while (true) {
    const emails = await options.prisma.email.findMany({
      ...(cursorId ? { where: { id: { gt: cursorId } } } : {}),
      select: emailProjectionSelect,
      orderBy: { id: 'asc' },
      take: batchSize,
    });
    if (emails.length === 0) break;

    report.rowsRead += emails.length;
    try {
      const result = await options.search.bulkIndexDocuments(
        emails.map(buildEmailSearchDocument),
        options.refresh === undefined ? {} : { refresh: options.refresh },
      );
      report.indexed += result.indexed;
      report.failures += result.failures.length;
      if (result.failures.length > 0) {
        options.logger?.error(
          { failures: result.failures, operation: 'reindex', index: options.search.indexName },
          'Elasticsearch bulk reindex contained failed items',
        );
      }
    } catch (error) {
      report.failures += emails.length;
      options.logger?.error(
        { error, operation: 'reindex', index: options.search.indexName },
        'Elasticsearch bulk reindex request failed',
      );
    }

    cursorId = emails.at(-1)?.id;
    if (emails.length < batchSize) break;
  }

  return report;
}
