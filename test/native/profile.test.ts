import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  expectError,
  parseWholeStdout,
  runCli,
  withSandbox,
  type Sandbox,
} from '../../src/test-support/cli-process.js';
import { calibrateTmuxTripwire } from './tmux-tripwire.js';

async function json(sandbox: Sandbox, args: string[]): Promise<unknown> {
  const result = await runCli(sandbox, [...args, '--json']);
  expect(result.status, result.stdout || result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  return parseWholeStdout(result);
}

describe('native role and preamble process contracts', () => {
  it('persists independent offline profiles across processes without config or tmux', async () => {
    await withSandbox(async (sandbox) => {
      const log = await calibrateTmuxTripwire(sandbox);
      await json(sandbox, ['identity', 'create', 'Alice']);
      await json(sandbox, ['identity', 'create', 'Bob']);
      mkdirSync(sandbox.globalDir, { recursive: true });
      writeFileSync(sandbox.globalConfig, '{ invalid');
      writeFileSync(sandbox.localConfig, '{ invalid');
      const original = '\ufeff  role\r\nline\r\tend  ';
      const normalized = '  role\nline\n\tend  ';
      const set = await json(sandbox, ['role', '--identity', 'aLiCe', 'set', original]);
      expect(set).toMatchObject({
        identity: { name: 'Alice', canonicalName: 'alice', lifetime: 'saved' },
        role: { content: normalized, updatedAt: expect.any(String) },
      });
      expect(await json(sandbox, ['role', 'show', '--identity', 'Alice'])).toEqual(set);
      expect(await json(sandbox, ['preamble', 'set', 'Bob', 'first', 'second'])).toEqual({
        agent: 'Bob',
        preamble: 'first second',
        status: 'set',
      });
      expect(await json(sandbox, ['preamble', 'set', 'Bob', 'beta'])).toEqual({
        agent: 'Bob',
        preamble: 'beta',
        status: 'set',
      });
      expect(await json(sandbox, ['preamble', 'set', 'Alice', '\ufeffprefix\r\n'])).toEqual({
        agent: 'Alice',
        preamble: 'prefix\n',
        status: 'set',
      });
      expect(await json(sandbox, ['preamble'])).toEqual({
        preambles: [
          { agent: 'Alice', preamble: 'prefix\n' },
          { agent: 'Bob', preamble: 'beta' },
        ],
      });
      expect(await json(sandbox, ['role', 'show', '--identity', 'Bob'])).toMatchObject({
        role: null,
      });
      expect(await json(sandbox, ['role', 'clear', '--identity', 'Alice'])).toMatchObject({
        role: null,
      });
      expect(await json(sandbox, ['role', 'clear', '--identity', 'Alice'])).toMatchObject({
        role: null,
      });
      expect(await json(sandbox, ['preamble', 'show', 'Alice'])).toEqual({
        agent: 'Alice',
        preamble: 'prefix\n',
      });
      expect(await json(sandbox, ['preamble', 'clear', 'Alice'])).toEqual({
        agent: 'Alice',
        status: 'cleared',
      });
      expect(await json(sandbox, ['preamble', 'clear', 'Alice'])).toEqual({
        agent: 'Alice',
        status: 'not_set',
      });
      expect(await json(sandbox, ['preamble', 'show', 'Alice'])).toEqual({
        agent: 'Alice',
        preamble: null,
      });
      expect(readFileSync(log, 'utf8')).toBe('\n');
    });
  });

  it('rejects unknown selectors and invalid text without creating or altering profiles', async () => {
    await withSandbox(async (sandbox) => {
      const log = await calibrateTmuxTripwire(sandbox);
      await json(sandbox, ['identity', 'create', 'Alice']);
      const initial = await json(sandbox, ['role', 'set', 'preserved', '--identity', 'Alice']);
      for (const args of [
        ['role', 'show', '--identity', 'bad\nname'],
        ['preamble', 'show', '%14'],
      ]) {
        const result = await runCli(sandbox, [...args, '--json']);
        expect(result.status).toBe(3);
        expectError(result, 'NAME_NOT_FOUND');
      }
      for (const [content, suffix] of [
        [' \ufeff\r\n', 'INVALID'],
        ['bad\u0007', 'INVALID'],
        ['x'.repeat(65_537), 'TOO_LARGE'],
      ]) {
        for (const kind of ['role', 'preamble']) {
          const args =
            kind === 'role'
              ? ['role', 'set', content, '--identity', 'Alice']
              : ['preamble', 'set', 'Alice', content];
          const result = await runCli(sandbox, [...args, '--json']);
          expect(result.status).toBe(1);
          expectError(result, `${kind.toUpperCase()}_INPUT_${suffix}`);
        }
      }
      expect(await json(sandbox, ['role', 'show', '--identity', 'Alice'])).toEqual(initial);
      const database = new Database(sandbox.database, { readonly: true });
      try {
        expect(database.prepare('SELECT name FROM identities').all()).toEqual([{ name: 'Alice' }]);
      } finally {
        database.close();
      }
      expect(readFileSync(log, 'utf8')).toBe('\n');
    });
  });

  it('reads only bounded regular role files and preserves state on every rejection', async () => {
    await withSandbox(async (sandbox) => {
      const log = await calibrateTmuxTripwire(sandbox);
      await json(sandbox, ['identity', 'create', 'Alice']);
      const file = path.join(sandbox.root, 'role.txt');
      const text = 'é'.repeat(32_768);
      writeFileSync(file, text);
      const original = await json(sandbox, ['role', 'set', '--file', file, '--identity', 'Alice']);
      expect(original).toMatchObject({ role: { content: text } });
      const fifo = path.join(sandbox.root, 'role.fifo');
      execFileSync('mkfifo', [fifo]);
      for (const [source, content, code] of [
        [file, Buffer.from([0xff]), 'ROLE_INPUT_INVALID'],
        [file, Buffer.alloc(65_537, 120), 'ROLE_INPUT_TOO_LARGE'],
        [sandbox.root, null, 'ROLE_FILE_ERROR'],
        [fifo, null, 'ROLE_FILE_ERROR'],
        [path.join(sandbox.root, 'missing'), null, 'ROLE_FILE_ERROR'],
      ] as const) {
        if (content) writeFileSync(source, content);
        const result = await runCli(
          sandbox,
          ['role', 'set', '--file', source, '--identity', 'Alice', '--json'],
          { deadlineMs: 2_000 }
        );
        expect(result.status).toBe(1);
        expectError(result, code);
        expect(await json(sandbox, ['role', 'show', '--identity', 'Alice'])).toEqual(original);
      }
      expect(readFileSync(log, 'utf8')).toBe('\n');
    });
  });
});
