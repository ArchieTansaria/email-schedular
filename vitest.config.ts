import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration projects share one isolated PostgreSQL test database. Serialize
    // projects so dependency-safe cleanup in one suite cannot delete another
    // suite's fixtures while it is exercising an HTTP request.
    maxWorkers: 1,
    projects: [
      'packages/shared',
      'packages/search',
      'packages/slack',
      'apps/api',
      'apps/worker',
      'apps/web',
      'prisma',
    ],
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: './coverage',
    },
  },
});
