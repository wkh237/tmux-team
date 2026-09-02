import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['test/e2e/**', 'node_modules', 'dist'],
    testTimeout: 1000,
    coverage: {
      all: true,
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
});
