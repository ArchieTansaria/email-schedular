import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'slack',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
