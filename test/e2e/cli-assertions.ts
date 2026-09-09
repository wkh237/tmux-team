import { expect } from 'vitest';
import type { CliResult } from './harness.js';

/** Assert the E2E JSON envelope; each scenario still owns its payload assertions. */
export function expectJsonResult<T>(result: CliResult<T>): T {
  expect(result.code, result.stderr || result.stdout).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.json, result.stdout).toBeDefined();
  return result.json as T;
}
