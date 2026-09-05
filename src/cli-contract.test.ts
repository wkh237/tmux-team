import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { getSkillConfigs } from './commands/install.js';
import { CURRENT_MIGRATIONS } from './storage/migrations.js';
import {
  expectError,
  expectJsonSuccess,
  fileSnapshot,
  initializeDatabase,
  parseWholeStdout,
  runCli,
  withSandbox,
} from './test-support/cli-process.js';
import type { Sandbox } from './test-support/cli-process.js';

function readMigrationHistory(sandbox: Sandbox): Array<{ version: number; name: string }> {
  const database = new Database(sandbox.database, { readonly: true });
  try {
    return database
      .prepare('SELECT version, name FROM _migrations ORDER BY version')
      .all() as Array<{ version: number; name: string }>;
  } finally {
    database.close();
  }
}

describe('real CLI process contract', () => {
  it(
    'installs all skill integrations into isolated HOME with shipped source bytes',
    { timeout: 10_000 },
    () =>
      withSandbox(async (sandbox) => {
        const result = await runCli(sandbox, ['install', 'all', '--json']);
        expect(result.status).toBe(0);
        const document = parseWholeStdout(result) as {
          installed: Array<{ agent: string; target: string }>;
        };
        expect(document.installed.map((item) => item.agent)).toEqual(['claude', 'codex', 'gemini']);

        const configs = getSkillConfigs();
        const claudeTarget = path.join(sandbox.home, '.claude', 'commands', 'team.md');
        const universalTarget = path.join(sandbox.home, '.agents', 'skills', 'tmux-team');
        expect(lstatSync(claudeTarget).isSymbolicLink()).toBe(true);
        expect(lstatSync(universalTarget).isSymbolicLink()).toBe(true);
        expect(realpathSync(claudeTarget)).toBe(realpathSync(configs.claude.source));
        expect(realpathSync(universalTarget)).toBe(realpathSync(configs.codex.source));
        expect(readFileSync(claudeTarget)).toEqual(readFileSync(configs.claude.source));
        expect(readFileSync(path.join(universalTarget, 'SKILL.md'))).toEqual(
          readFileSync(path.join(configs.codex.source, 'SKILL.md'))
        );
      })
  );

  it(
    'reports JSON parse errors regardless of --json position without creating context state',
    { timeout: 10_000 },
    () =>
      withSandbox(async (sandbox) => {
        const before = fileSnapshot(sandbox.root);

        for (const args of [
          ['--json', 'name'],
          ['name', '--json'],
        ]) {
          const result = await runCli(sandbox, args);
          expect(result.status).toBe(1);
          expectError(result, 'USAGE_ERROR');
          expect(fileSnapshot(sandbox.root)).toEqual(before);
        }
      })
  );

  it(
    'reports malformed configuration before initialization and preserves the file',
    { timeout: 10_000 },
    () =>
      withSandbox(async (sandbox) => {
        mkdirSync(sandbox.globalDir, { recursive: true });
        writeFileSync(sandbox.globalConfig, '{ malformed\n');
        const before = fileSnapshot(sandbox.root);

        const result = await runCli(sandbox, ['list', '--json']);

        expect(result.status).toBe(1);
        expectError(result, 'CONFIG_ERROR');
        expect(fileSnapshot(sandbox.root)).toEqual(before);
        expect(existsSync(sandbox.database)).toBe(false);
      })
  );

  it(
    'preserves the missing explicit identity exit code and JSON error envelope',
    { timeout: 10_000 },
    () =>
      withSandbox(async (sandbox) => {
        const result = await runCli(sandbox, ['role', 'show', '--identity', 'missing', '--json']);

        expect(result.status).toBe(3);
        expectError(result, 'NAME_NOT_FOUND', "Identity 'missing' was not found.");
        expect(existsSync(sandbox.database)).toBe(true);
      })
  );

  it(
    'maps an incompatible future schema to one role error without changing migration history',
    { timeout: 10_000 },
    () =>
      withSandbox(async (sandbox) => {
        mkdirSync(sandbox.globalDir, { recursive: true });
        const database = new Database(sandbox.database);
        try {
          database.exec(`
            CREATE TABLE _migrations (
              version INTEGER PRIMARY KEY,
              name TEXT NOT NULL,
              applied_at TEXT NOT NULL
            );
          `);
          const insert = database.prepare(
            'INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)'
          );
          for (const migration of CURRENT_MIGRATIONS)
            insert.run(migration.version, migration.name, '2026-01-01T00:00:00.000Z');
          insert.run(
            CURRENT_MIGRATIONS.at(-1)!.version + 1,
            'future migration',
            '2026-01-01T00:00:00.000Z'
          );
        } finally {
          database.close();
        }
        const before = readMigrationHistory(sandbox);

        const result = await runCli(sandbox, ['role', 'show', '--identity', 'missing', '--json']);

        expect(result.status).toBe(1);
        const document = expectError(result, 'ROLE_ERROR');
        expect((document.error as { message: string }).message).toContain(
          'unsupported migration version'
        );
        expect(readMigrationHistory(sandbox)).toEqual(before);
      })
  );

  it('pipes a large real role result as one complete JSON document', { timeout: 10_000 }, () =>
    withSandbox(async (sandbox) => {
      initializeDatabase(sandbox);
      // Multibyte fixture data verifies that the real pipe preserves Unicode
      // boundaries while transporting a large structured result.
      const content = 'role-content-日本語-🚀-' + 'x'.repeat(48 * 1024);
      const database = new Database(sandbox.database);
      try {
        database
          .prepare(
            'INSERT INTO identities (id, name, canonical_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
          )
          .run(
            'identity-large',
            'LargeRole',
            'largerole',
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z'
          );
        database
          .prepare('INSERT INTO role_profiles (identity_id, content, updated_at) VALUES (?, ?, ?)')
          .run('identity-large', content, '2026-01-01T00:00:00.000Z');
      } finally {
        database.close();
      }

      const result = await runCli(sandbox, ['role', 'show', '--identity', 'LargeRole', '--json']);

      expect(result.status).toBe(0);
      const document = parseWholeStdout(result) as {
        identity: { name: string; canonicalName: string };
        role: { content: string };
      };
      expect(result.stdout.length).toBeGreaterThan(32 * 1024);
      expect(document.identity).toEqual({
        id: 'identity-large',
        name: 'LargeRole',
        canonicalName: 'largerole',
      });
      expect(document.role.content).toBe(content);
    })
  );

  it(
    'returns an explicit JSON success document while config set and clear persist safely',
    { timeout: 10_000 },
    () =>
      withSandbox(async (sandbox) => {
        writeFileSync(sandbox.localConfig, '{"keep":{"value":true}}\n');

        const setResult = await runCli(sandbox, ['config', 'set', 'mode', 'polling', '--json']);
        expectJsonSuccess(setResult, { ok: true });
        expect(JSON.parse(readFileSync(sandbox.localConfig, 'utf8'))).toEqual({
          keep: { value: true },
          $config: { mode: 'polling' },
        });

        const clearResult = await runCli(sandbox, ['config', 'clear', 'mode', '--json']);
        expectJsonSuccess(clearResult, { ok: true });
        expect(JSON.parse(readFileSync(sandbox.localConfig, 'utf8'))).toEqual({
          keep: { value: true },
        });
        expect(existsSync(sandbox.database)).toBe(false);
      })
  );

  it('does not overwrite a preexisting local config when init fails', { timeout: 10_000 }, () =>
    withSandbox(async (sandbox) => {
      const original = '{"keep":"original"}\n';
      writeFileSync(sandbox.localConfig, original);

      const result = await runCli(sandbox, ['init', '--json']);

      expect(result.status).toBe(1);
      const document = parseWholeStdout(result);
      expect(document.error).toMatchObject({ code: 'ERROR' });
      expect((document.error as { message: string }).message).toContain('already exists');
      expect(readFileSync(sandbox.localConfig, 'utf8')).toBe(original);
      expect(existsSync(sandbox.database)).toBe(false);
    })
  );

  it(
    'rejects JSON mode for text-only help, version, completion, and learn commands',
    { timeout: 10_000 },
    () =>
      withSandbox(async (sandbox) => {
        const before = fileSnapshot(sandbox.root);
        const commands = [
          ['help', '--json'],
          ['--json', '--help'],
          ['--version', '--json'],
          ['completion', 'bash', '--json'],
          ['learn', '--json'],
        ];

        for (const args of commands) {
          const result = await runCli(sandbox, args);
          expect(result.status).toBe(1);
          expectError(result, 'JSON_UNSUPPORTED');
          expect(fileSnapshot(sandbox.root)).toEqual(before);
        }
      })
  );

  it('keeps human identity errors concise without a stack trace', { timeout: 10_000 }, () =>
    withSandbox(async (sandbox) => {
      const result = await runCli(sandbox, ['role', 'show', '--identity', 'missing']);

      expect(result.status).toBe(3);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain("Identity 'missing' was not found.");
      expect(result.stderr).not.toContain(' at ');
      expect(result.stderr).not.toContain('Error:');
    })
  );
});
