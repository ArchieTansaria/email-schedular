import { Client } from '@elastic/elasticsearch';
import { z } from 'zod';

const emptyStringToUndefined = (value: unknown): unknown => (value === '' ? undefined : value);

const searchConfigSchema = z.object({
  ELASTICSEARCH_URL: z.url(),
  ELASTICSEARCH_API_KEY: z.preprocess(emptyStringToUndefined, z.string().min(1).optional()),
});

const reindexConfigSchema = searchConfigSchema.extend({
  DATABASE_URL: z
    .url()
    .refine(
      (value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol),
      'DATABASE_URL must use postgres or postgresql',
    ),
});

export interface ElasticsearchConnectionConfig {
  ELASTICSEARCH_URL: string;
  ELASTICSEARCH_API_KEY?: string | undefined;
}

export function parseSearchConfig(input: Record<string, unknown>): ElasticsearchConnectionConfig {
  return searchConfigSchema.parse(input);
}

export function parseReindexConfig(input: Record<string, unknown>) {
  return reindexConfigSchema.parse(input);
}

export function createElasticsearchClient(config: ElasticsearchConnectionConfig): Client {
  return new Client({
    node: config.ELASTICSEARCH_URL,
    ...(config.ELASTICSEARCH_API_KEY ? { auth: { apiKey: config.ELASTICSEARCH_API_KEY } } : {}),
  });
}
