import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
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
