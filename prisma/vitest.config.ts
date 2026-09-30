import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

import { defineConfig } from 'vitest/config';

const root = resolve(import.meta.dirname, '..');
const envPath = resolve(root, '.env');
const loadedEnvironment = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: 'database',
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    env: {
      TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? loadedEnvironment.TEST_DATABASE_URL ?? '',
    },
    sequence: {
      concurrent: false,
    },
  },
});
