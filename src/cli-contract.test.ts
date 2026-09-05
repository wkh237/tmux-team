import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { CURRENT_MIGRATIONS } from './storage/migrations.js';
import { openStorageWithMigrations } from './storage/sqlite-adapter.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binPath = path.join(repoRoot, 'bin', 'tmux-team');
const maxSubprocessOutputBytes = 1024 * 1024;

interface Sandbox {
  readonly root: string;
  readonly cwd: string;
  readonly home: string;
  readonly xdgConfigHome: string;
  readonly globalDir: string;
  readonly globalConfig: string;
  readonly database: string;
  readonly localConfig: string;
  readonly env: NodeJS.ProcessEnv;
}

interface CliResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

type JsonDocument = Record<string, unknown>;

function createSandbox(): Sandbox {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tmux-team-cli-contract-'));
  try {
    const cwd = path.join(root, 'cwd');
    const home = path.join(root, 'home');
    const xdgConfigHome = path.join(root, 'xdg');
    mkdirSync(cwd);
    mkdirSync(home);

    const globalDir = path.join(xdgConfigHome, 'tmux-team');
    return {
      root,
      cwd,
      home,
      xdgConfigHome,
      globalDir,
      globalConfig: path.join(globalDir, 'config.json'),
      database: path.join(globalDir, 'tmux-team.db'),
      localConfig: path.join(cwd, 'tmux-team.json'),
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: xdgConfigHome,
        // The contract suite removes inherited tmux/config overrides before each
        // child starts, so it never depends on the developer's session.
      },
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function runCli(sandbox: Sandbox, args: readonly string[]): Promise<CliResult> {
  for (const key of ['TMUX', 'TMUX_PANE', 'TMUX_TEAM_HOME']) delete sandbox.env[key];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd: sandbox.cwd,
      env: sandbox.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // Decode at the stream boundary so a multibyte UTF-8 character split
    // across OS chunks cannot be corrupted by per-buffer toString() calls.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let outputLimitExceeded = false;
    const killProcessGroup = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      // The wrapper launches the TypeScript child; kill the process group so a
      // timeout cannot leave that descendant running after the test exits.
      killProcessGroup();
    }, 5_000);
    const readOutput =
      (stream: 'stdout' | 'stderr') =>
      (chunk: Buffer | string): void => {
        const text = chunk.toString();
        const nextBytes =
          Buffer.byteLength(text) + Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
        if (nextBytes > maxSubprocessOutputBytes) {
          outputLimitExceeded = true;
          killProcessGroup();
          return;
        }
        if (stream === 'stdout') stdout += text;
        else stderr += text;
      };
    child.stdout.on('data', readOutput('stdout'));
    child.stderr.on('data', readOutput('stderr'));
    child.on('error', (error) => {
      clearTimeout(timer);
      if (outputLimitExceeded) {
        reject(
          new Error(`CLI subprocess exceeded the ${maxSubprocessOutputBytes}-byte output bound.`)
        );
      } else reject(error);
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      if (outputLimitExceeded) {
        reject(
          new Error(`CLI subprocess exceeded the ${maxSubprocessOutputBytes}-byte output bound.`)
        );
      } else if (timedOut) {
        reject(new Error('CLI subprocess exceeded the 5 second test bound.'));
        return;
      }
      resolve({ status, signal, stdout, stderr });
    });
  });
}

function parseWholeStdout(result: CliResult): JsonDocument {
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe('');
  expect(result.stdout.trim()).not.toBe('');
  // Parse the complete stream. Parsing only the final line would allow human
  // output or a second JSON document to leak into JSON mode unnoticed.
  const document = JSON.parse(result.stdout) as unknown;
  expect(document).toBeTypeOf('object');
  expect(document).not.toBeNull();
  return document as JsonDocument;
}

function expectError(result: CliResult, code: string, message?: string): JsonDocument {
  const document = parseWholeStdout(result);
  expect(document.error).toMatchObject({ code });
  expect(document.error).toHaveProperty('message', expect.any(String));
  expect((document.error as { message: string }).message.length).toBeGreaterThan(0);
  if (message !== undefined) expect((document.error as { message: string }).message).toBe(message);
  return document;
}

function expectJsonSuccess(result: CliResult, value: JsonDocument): void {
  expect(result.status).toBe(0);
  expect(parseWholeStdout(result)).toEqual(value);
}

function fileSnapshot(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else snapshot[path.relative(root, entryPath)] = readFileSync(entryPath, 'utf8');
    }
  };
  visit(root);
  return snapshot;
}

async function withSandbox<T>(callback: (sandbox: Sandbox) => T | Promise<T>): Promise<T> {
  const sandbox = createSandbox();
  try {
    return await callback(sandbox);
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
}

function initializeDatabase(sandbox: Sandbox): void {
  let storage: ReturnType<typeof openStorageWithMigrations> | undefined;
  try {
    storage = openStorageWithMigrations(sandbox.database, CURRENT_MIGRATIONS);
  } finally {
    storage?.close();
  }
}

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
          insert.run(5, 'future migration', '2026-01-01T00:00:00.000Z');
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
