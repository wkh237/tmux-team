import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StorageError } from './errors.js';
import { applyMigrations, CURRENT_MIGRATIONS, type MigrationDefinition } from './migrations.js';
import { openStorage, openStorageWithMigrations } from './sqlite-adapter.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-storage-'));
  temporaryDirectories.push(directory);
  return directory;
}

function location(directory: string): { globalDir: string; databaseFile: string } {
  return { globalDir: directory, databaseFile: path.join(directory, 'tmux-team.db') };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('SQLite storage adapter', () => {
  it('opens a private database with required pragmas and the durable identity schema', () => {
    const directory = temporaryDirectory();
    const storage = openStorage(location(directory));
    expect(storage).not.toHaveProperty('database');

    expect(storage.health()).toMatchObject({
      open: true,
      schemaVersion: 3,
      journalMode: 'wal',
      foreignKeys: true,
      busyTimeoutMs: 5000,
      synchronous: 'normal',
      fts5: true,
    });
    if (process.platform !== 'win32') {
      for (const suffix of ['', '-wal', '-shm']) {
        const file = path.join(directory, `tmux-team.db${suffix}`);
        if (fs.existsSync(file)) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      }
    }
    storage.close();

    const database = new Database(path.join(directory, 'tmux-team.db'), { readonly: true });
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    expect(tables.map((table) => table.name).sort()).toEqual([
      '_migrations',
      'bindings',
      'identities',
      'identity_preambles',
      'role_profiles',
    ]);
    database.close();
    if (process.platform !== 'win32') {
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(directory, 'tmux-team.db')).mode & 0o777).toBe(0o600);
    }
  });

  it('applies contiguous migrations exactly once and remains idempotent', () => {
    const directory = temporaryDirectory();
    const migrations: MigrationDefinition[] = [
      {
        version: 1,
        name: 'create test ledger',
        up: (database) =>
          database.exec('CREATE TABLE ledger (id INTEGER PRIMARY KEY, value TEXT NOT NULL)'),
      },
      {
        version: 2,
        name: 'add ledger index',
        up: (database) => database.exec('CREATE INDEX ledger_value ON ledger(value)'),
      },
    ];

    const first = openStorageWithMigrations(location(directory), migrations);
    expect(first.health().schemaVersion).toBe(2);
    first.close();
    const second = openStorageWithMigrations(location(directory), migrations);
    expect(second.health().schemaVersion).toBe(2);
    second.close();

    const database = new Database(path.join(directory, 'tmux-team.db'), { readonly: true });
    expect(database.prepare('SELECT COUNT(*) AS count FROM _migrations').get()).toEqual({
      count: 2,
    });
    database.close();
  });

  it('rejects future and non-contiguous schema history without changing it', () => {
    const directory = temporaryDirectory();
    const database = new Database(path.join(directory, 'tmux-team.db'));
    database.exec(
      'CREATE TABLE _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL); ' +
        "INSERT INTO _migrations VALUES (3, 'future', '2026-01-01T00:00:00.000Z')"
    );
    database.close();

    expect(() => openStorage(location(directory))).toThrowError(StorageError);
    try {
      openStorage(location(directory));
    } catch (error) {
      expect(error).toMatchObject({ code: 'incompatible-schema' });
    }
  });

  it('rejects a database with an incompatible migration table', () => {
    const directory = temporaryDirectory();
    const database = new Database(path.join(directory, 'tmux-team.db'));
    database.exec('CREATE TABLE _migrations (version TEXT PRIMARY KEY, label TEXT NOT NULL)');
    database.close();

    expect(() => openStorage(location(directory))).toThrowError(StorageError);
    try {
      openStorage(location(directory));
    } catch (error) {
      expect(error).toMatchObject({ code: 'incompatible-schema' });
    }
  });

  it('rolls back a failed migration and can recover on the next open', () => {
    const directory = temporaryDirectory();
    let shouldFail = true;
    const migrations: MigrationDefinition[] = [
      {
        version: 1,
        name: 'create recovery ledger',
        up: (database) => database.exec('CREATE TABLE recovery_ledger (id INTEGER PRIMARY KEY)'),
      },
      {
        version: 2,
        name: 'recoverable migration',
        up: (database) => {
          if (shouldFail) throw new Error('simulated migration failure');
          database.exec('CREATE INDEX recovery_ledger_id ON recovery_ledger(id)');
        },
      },
    ];

    try {
      openStorageWithMigrations(location(directory), migrations);
      expect.fail('expected the second migration to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(StorageError);
      expect(error).toMatchObject({ code: 'migration', migrationVersion: 2, retryable: false });
      expect((error as StorageError).cause).toMatchObject({ code: 'unknown' });
    }
    const afterFailure = new Database(path.join(directory, 'tmux-team.db'), { readonly: true });
    expect(afterFailure.prepare('SELECT version, name FROM _migrations').all()).toEqual([
      { version: 1, name: 'create recovery ledger' },
    ]);
    expect(
      afterFailure
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'recovery_ledger_id'"
        )
        .get()
    ).toBeUndefined();
    afterFailure.close();

    shouldFail = false;
    const recovered = openStorageWithMigrations(location(directory), migrations);
    expect(recovered.health().schemaVersion).toBe(2);
    recovered.close();
  });

  it('rechecks schema history under the write lock when another connection upgrades first', () => {
    const file = location(temporaryDirectory()).databaseFile;
    const first = new Database(file);
    const second = new Database(file);
    try {
      applyMigrations(first, CURRENT_MIGRATIONS.slice(0, 1));
      const prepare = first.prepare.bind(first);
      let interleave = true;
      const spy = vi.spyOn(first, 'prepare').mockImplementation((sql: string) => {
        const statement = prepare(sql);
        if (sql === 'SELECT version, name FROM _migrations ORDER BY version' && interleave) {
          const all = statement.all.bind(statement);
          vi.spyOn(statement, 'all').mockImplementation(() => {
            const staleHistory = all();
            interleave = false;
            applyMigrations(second);
            return staleHistory;
          });
        }
        return statement;
      });
      expect(applyMigrations(first)).toBe(3);
      spy.mockRestore();
      expect(interleave).toBe(false);
      expect(first.prepare('SELECT version FROM _migrations ORDER BY version').all()).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
      ]);
      expect(
        first.prepare("SELECT name FROM sqlite_master WHERE name = 'role_profiles'").all()
      ).toEqual([{ name: 'role_profiles' }]);
      expect(
        first.prepare("SELECT name FROM sqlite_master WHERE name = 'identity_preambles'").all()
      ).toEqual([{ name: 'identity_preambles' }]);
    } finally {
      first.close();
      second.close();
    }
  });

  it('maps corrupt databases while retaining the native cause', () => {
    const directory = temporaryDirectory();
    const databaseFile = path.join(directory, 'tmux-team.db');
    fs.writeFileSync(databaseFile, 'not a sqlite database');

    try {
      openStorage(location(directory));
      expect.fail('expected a structured corruption error');
    } catch (error) {
      expect(error).toBeInstanceOf(StorageError);
      expect(error).toMatchObject({ code: 'corrupt', retryable: false });
      expect((error as StorageError).cause).toBeDefined();
    }
  });

  it('supports twenty-four concurrent short-lived writers with exact accounting', async () => {
    const directory = temporaryDirectory();
    const storage = openStorageWithMigrations(location(directory), [
      {
        version: 1,
        name: 'create writer ledger',
        up: (database) =>
          database.exec(
            'CREATE TABLE writer_ledger (id INTEGER PRIMARY KEY, writer TEXT NOT NULL)'
          ),
      },
    ]);
    storage.close();

    const databaseFile = path.join(directory, 'tmux-team.db');
    const writerCount = 24;
    const workerSource = `
      import Database from 'better-sqlite3';
      const [databaseFile, writer] = process.argv.slice(1);
      const connection = new Database(databaseFile);
      connection.pragma('busy_timeout = 5000');
      connection.pragma('journal_mode = WAL');
      connection.transaction(() => {
        connection.prepare('INSERT INTO writer_ledger (id, writer) VALUES (?, ?)')
          .run(Number(writer), 'writer-' + writer);
      }).immediate();
      connection.close();
    `;
    const writers = Array.from(
      { length: writerCount },
      (_, writer) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ['--input-type=module', '--eval', workerSource, databaseFile, String(writer)],
            { stdio: ['ignore', 'ignore', 'pipe'] }
          );
          let stderr = '';
          child.stderr.setEncoding('utf8');
          child.stderr.on('data', (chunk) => (stderr += chunk));
          child.once('error', reject);
          child.once('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`writer ${writer} exited ${code}: ${stderr}`));
          });
        })
    );
    await Promise.all(writers);

    const verification = new Database(databaseFile, { readonly: true });
    const result = verification
      .prepare('SELECT COUNT(*) AS count, COUNT(DISTINCT writer) AS writers FROM writer_ledger')
      .get() as { count: number; writers: number };
    expect(result).toEqual({ count: writerCount, writers: writerCount });
    verification.close();
  }, 20_000);
});
