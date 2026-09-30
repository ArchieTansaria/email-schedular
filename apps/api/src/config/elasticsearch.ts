import { Client } from '@elastic/elasticsearch';

import type { ApiConfig } from './env.js';

export function createElasticsearchClient(
  config: Pick<ApiConfig, 'ELASTICSEARCH_API_KEY' | 'ELASTICSEARCH_URL'>,
): Client {
  return new Client({
    node: config.ELASTICSEARCH_URL,
    ...(config.ELASTICSEARCH_API_KEY ? { auth: { apiKey: config.ELASTICSEARCH_API_KEY } } : {}),
  });
}
