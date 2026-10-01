import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

import { defineConfig } from 'vitest/config';

const root = resolve(import.meta.dirname, '../..');
const envPath = resolve(root, '.env');
const loadedEnvironment = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};

export default defineConfig({
  test: {
    name: 'api',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: {
      TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? loadedEnvironment.TEST_DATABASE_URL ?? '',
      REDIS_URL: process.env.REDIS_URL ?? loadedEnvironment.REDIS_URL ?? 'redis://localhost:6379',
    },
    sequence: { concurrent: false },
    fileParallelism: false,
  },
});
