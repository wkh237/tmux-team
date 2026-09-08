import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/tooling/**/*.test.ts'],
    exclude: ['test/e2e/**', 'node_modules', 'dist'],
    testTimeout: 1000,
  },
});
