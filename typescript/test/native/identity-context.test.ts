import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expectError, runCli, withSandbox } from '../support/cli-process.js';
import { installTmuxTripwire } from './tmux-tripwire.js';

describe('required identity preflight', () => {
  it.each(
    [
      ['role', 'show'],
      ['role', 'set', 'must not write'],
      ['role', 'clear'],
      ['x', 'list'],
      ['x', 'show', 'missing-request'],
      ['x', 'ack', 'missing-request', '--revision', '1'],
      ['x', 'ackall'],
    ].map((args) => ({ label: args.join(' '), args }))
  )('rejects $label without initializing storage for an outside caller', async ({ args }) => {
    await withSandbox(async (sandbox) => {
      installTmuxTripwire(sandbox);
      expect(existsSync(sandbox.database)).toBe(false);
      const result = await runCli(sandbox, [...args, '--json']);
      expect(result.status).toBe(1);
      expectError(result, 'IDENTITY_REQUIRED');
      expect(existsSync(sandbox.database)).toBe(false);
      expect(existsSync(`${sandbox.database}-wal`)).toBe(false);
      expect(existsSync(`${sandbox.database}-shm`)).toBe(false);
    });
  });
});
