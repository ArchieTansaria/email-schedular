import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL is required for database test commands');
}

if (testDatabaseUrl === process.env.DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL must not match DATABASE_URL');
}

const databaseName = new URL(testDatabaseUrl).pathname.slice(1);
if (!databaseName.endsWith('_test') && !databaseName.endsWith('_rebuild')) {
  throw new Error('Refusing to run: test database name must end in _test or _rebuild');
}

const result = spawnSync('pnpm', ['exec', 'prisma', ...process.argv.slice(2)], {
  env: { ...process.env, DATABASE_URL: testDatabaseUrl },
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
