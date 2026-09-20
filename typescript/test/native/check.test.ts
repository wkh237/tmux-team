import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expectError, fileSnapshot, runCli, withSandbox } from '../support/cli-process.js';
import { calibrateTmuxTripwire } from './tmux-tripwire.js';

describe('native check process preflight', () => {
  it('validates configuration before any tmux call or storage creation', async () => {
    for (const local of [false, true]) {
      await withSandbox(async (sandbox) => {
        const log = await calibrateTmuxTripwire(sandbox);
        mkdirSync(sandbox.globalDir, { recursive: true });
        writeFileSync(local ? sandbox.localConfig : sandbox.globalConfig, '{ invalid config');
        const before = fileSnapshot(sandbox.root);
        const result = await runCli(sandbox, ['check', '%14', '--json']);
        expect(result.status).toBe(1);
        expectError(result, 'CONFIG_ERROR');
        expect(result.stderr).toBe('');
        expect(existsSync(sandbox.database)).toBe(false);
        expect(readFileSync(log, 'utf8')).toBe('\n');
        expect(fileSnapshot(sandbox.root)).toEqual(before);
      });
    }
  });

  it('does not create unknown names or perform endpoint IO for lookup-only misses', async () => {
    await withSandbox(async (sandbox) => {
      const log = await calibrateTmuxTripwire(sandbox);
      for (const name of ['NeverCreated', 'bad\nname']) {
        const result = await runCli(sandbox, ['read', name, '--json']);
        expect(result.status).toBe(3);
        expectError(result, 'NAME_NOT_FOUND');
        expect(result.stderr).toBe('');
      }
      expect(readFileSync(log, 'utf8')).toBe('\n');
      const database = new Database(sandbox.database, { readonly: true });
      try {
        expect(database.prepare('SELECT COUNT(*) AS count FROM identities').get()).toEqual({
          count: 0,
        });
      } finally {
        database.close();
      }
    });
  });
});
