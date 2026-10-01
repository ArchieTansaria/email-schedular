import { errors, type Client } from '@elastic/elasticsearch';
import { EmailStatus, type PrismaClient } from '@prisma/client';

import {
  buildEmailSearchDocument,
  emailProjectionSelect,
  type EmailSearchDocument,
} from './document.js';
import { EMAIL_INDEX_MAPPING, EMAIL_SEARCH_INDEX } from './index-definition.js';

export interface BulkProjectionFailure {
  emailId: string;
  reason: string;
}

export interface BulkProjectionResult {
  indexed: number;
  failures: BulkProjectionFailure[];
}

export interface EmailSearchProjection {
  indexCampaign(campaignId: string): Promise<BulkProjectionResult>;
  projectEmail(emailId: string): Promise<boolean>;
}

export interface EmailSearchQuery {
  userId: string;
  q: string;
  status?: EmailStatus | undefined;
  statuses?: readonly EmailStatus[] | undefined;
  page: number;
  limit: number;
}

export interface EmailSearchResult {
  items: EmailSearchDocument[];
  total: number;
  page: number;
  limit: number;
}

export class BulkProjectionError extends Error {
  readonly failures: readonly BulkProjectionFailure[];

  constructor(failures: readonly BulkProjectionFailure[]) {
    super(`Elasticsearch rejected ${failures.length} email projection item(s)`);
    this.name = 'BulkProjectionError';
    this.failures = failures;
  }
}

export class EmailSearchService implements EmailSearchProjection {
  readonly #client: Client;
  readonly #prisma: PrismaClient;
  readonly indexName: string;

  constructor(options: { client: Client; prisma: PrismaClient; indexName?: string }) {
    this.#client = options.client;
    this.#prisma = options.prisma;
    this.indexName = options.indexName ?? EMAIL_SEARCH_INDEX;
  }

  async ensureIndex(): Promise<'created' | 'existing'> {
    return ensureEmailSearchIndex(this.#client, this.indexName);
  }

  async indexCampaign(campaignId: string): Promise<BulkProjectionResult> {
    const emails = await this.#prisma.email.findMany({
      where: { campaignId },
      select: emailProjectionSelect,
      orderBy: [{ originalScheduledAt: 'asc' }, { id: 'asc' }],
    });
    const result = await this.bulkIndexDocuments(emails.map(buildEmailSearchDocument));
    if (result.failures.length > 0) throw new BulkProjectionError(result.failures);
    return result;
  }

  async projectEmail(emailId: string): Promise<boolean> {
    const email = await this.#prisma.email.findUnique({
      where: { id: emailId },
      select: emailProjectionSelect,
    });
    if (!email) return false;

    await this.#client.index({
      index: this.indexName,
      id: email.id,
      document: buildEmailSearchDocument(email),
    });
    return true;
  }

  async bulkIndexDocuments(
    documents: readonly EmailSearchDocument[],
    options: { refresh?: boolean | 'wait_for' } = {},
  ): Promise<BulkProjectionResult> {
    if (documents.length === 0) return { indexed: 0, failures: [] };

    const response = await this.#client.bulk({
      ...(options.refresh === undefined ? {} : { refresh: options.refresh }),
      operations: documents.flatMap((document) => [
        { index: { _index: this.indexName, _id: document.emailId } },
        document,
      ]),
    });
    const failures: BulkProjectionFailure[] = [];

    for (const [index, item] of response.items.entries()) {
      const operation = item.index;
      if (operation?.error) {
        failures.push({
          emailId: documents[index]?.emailId ?? operation._id ?? 'unknown',
          reason:
            typeof operation.error === 'string' ? operation.error : JSON.stringify(operation.error),
        });
      }
    }

    return { indexed: documents.length - failures.length, failures };
  }

  async search(input: EmailSearchQuery): Promise<EmailSearchResult> {
    const filters: Array<Record<string, unknown>> = [{ term: { userId: input.userId } }];
    if (input.statuses?.length) filters.push({ terms: { status: input.statuses } });
    else if (input.status) filters.push({ term: { status: input.status } });

    const response = await this.#client.search<EmailSearchDocument>({
      index: this.indexName,
      from: (input.page - 1) * input.limit,
      size: input.limit,
      track_total_hits: true,
      query: {
        bool: {
          filter: filters,
          must: [
            {
              multi_match: {
                query: input.q,
                fields: ['subject^2', 'body', 'recipientEmail.search', 'senderEmail.search'],
              },
            },
          ],
        },
      },
      sort: [{ _score: { order: 'desc' } }, { scheduledAt: 'desc' }],
    });

    return {
      items: response.hits.hits.flatMap((hit) => (hit._source ? [hit._source] : [])),
      total:
        typeof response.hits.total === 'number'
          ? response.hits.total
          : (response.hits.total?.value ?? 0),
      page: input.page,
      limit: input.limit,
    };
  }
}

export async function ensureEmailSearchIndex(
  client: Client,
  indexName: string = EMAIL_SEARCH_INDEX,
): Promise<'created' | 'existing'> {
  if (await client.indices.exists({ index: indexName })) {
    await verifyEmailSearchMapping(client, indexName);
    return 'existing';
  }
  try {
    await client.indices.create({ index: indexName, mappings: EMAIL_INDEX_MAPPING });
    return 'created';
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      await verifyEmailSearchMapping(client, indexName);
      return 'existing';
    }
    throw error;
  }
}

async function verifyEmailSearchMapping(client: Client, indexName: string): Promise<void> {
  const mapping = await client.indices.getMapping({ index: indexName });
  const properties = mapping[indexName]?.mappings.properties;
  const expectedTypes = {
    emailId: 'keyword',
    campaignId: 'keyword',
    userId: 'keyword',
    senderId: 'keyword',
    recipientEmail: 'keyword',
    senderEmail: 'keyword',
    subject: 'text',
    body: 'text',
    status: 'keyword',
    originalScheduledAt: 'date',
    scheduledAt: 'date',
    sentAt: 'date',
    failureReason: 'text',
  } as const;

  for (const [field, expectedType] of Object.entries(expectedTypes)) {
    const definition = properties?.[field];
    if (!definition || !('type' in definition) || definition.type !== expectedType) {
      throw new Error(
        `Elasticsearch index ${indexName} has incompatible mapping for ${field}; expected ${expectedType}`,
      );
    }
  }
}

export function isEmailStatus(value: string): value is EmailStatus {
  return Object.values(EmailStatus).some((status) => status === value);
}

function isAlreadyExistsError(error: unknown): boolean {
  if (!(error instanceof errors.ResponseError)) return false;
  const body = error.meta.body;
  if (typeof body !== 'object' || body === null || !('error' in body)) return false;
  const responseError = Reflect.get(body, 'error');
  return (
    typeof responseError === 'object' &&
    responseError !== null &&
    Reflect.get(responseError, 'type') === 'resource_already_exists_exception'
  );
}
