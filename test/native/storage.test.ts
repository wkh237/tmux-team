import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { openStorage } from '../../src/storage/sqlite-adapter.js';
import { resolveCliExecutables } from '../../src/test-support/cli-executable.mjs';
import {
  expectError,
  parseWholeStdout,
  runCli,
  withSandbox,
  type Sandbox,
} from '../../src/test-support/cli-process.js';
import {
  FIXTURE_ATTEMPT_COUNT,
  FIXTURE_FINAL_BODY,
  FIXTURE_FINAL_REQUEST_ID,
  FIXTURE_IDENTITY_ID,
  seedStoragePrefix,
  storageSnapshot,
} from './storage-fixture.js';

// A development-only executable, never a hidden SQL command in the installed CLI.
if (!process.env.TMT_TEST_STORAGE_PROBE) {
  throw new Error('Select the native storage probe with TMT_TEST_STORAGE_PROBE.');
}
const { cli: probe } = resolveCliExecutables({
  TMT_TEST_CLI: process.env.TMT_TEST_STORAGE_PROBE,
});

function runStorage(sandbox: Sandbox, file = sandbox.database) {
  return runCli({ ...sandbox, cli: probe }, [file], { deadlineMs: 10_000 });
}

function upgradeWithTypeScript(file: string): void {
  const storage = openStorage(file);
  try {
    expect(storage.health().schemaVersion).toBe(8);
  } finally {
    storage.close();
  }
}

function migrationTimestamps(file: string): string[] {
  const database = new Database(file, { readonly: true });
  try {
    return database
      .prepare('SELECT applied_at FROM _migrations ORDER BY version')
      .pluck()
      .all() as string[];
  } finally {
    database.close();
  }
}

describe('native SQLite lifecycle compatibility', () => {
  it.each(Array.from({ length: 9 }, (_, version) => version))(
    'upgrades closed TypeScript schema %i without changing schema or durable semantics',
    async (version) => {
      await withSandbox(async (sandbox) => {
        const reference = path.join(sandbox.root, 'reference', 'state.db');
        seedStoragePrefix(reference, version);
        seedStoragePrefix(sandbox.database, version);
        const originalTimestamps = migrationTimestamps(sandbox.database);
        upgradeWithTypeScript(reference);

        const result = await runStorage(sandbox);
        expect(result.status).toBe(0);
        expect(parseWholeStdout(result)).toEqual({
          path: sandbox.database,
          open: true,
          schemaVersion: 8,
          journalMode: 'wal',
          foreignKeys: true,
          busyTimeoutMs: 5000,
          synchronous: 'normal',
          fts5: true,
        });
        const migrated = storageSnapshot(sandbox.database);
        expect(migrated).toEqual(storageSnapshot(reference));
        if (version >= 5) {
          const responses = migrated.tables.find(
            (table) => table.name === 'request_responses'
          )!.rows;
          expect(responses).toHaveLength(FIXTURE_ATTEMPT_COUNT);
          expect(
            responses.find((row) => row.request_id === FIXTURE_FINAL_REQUEST_ID)
          ).toMatchObject({
            body: FIXTURE_FINAL_BODY,
            body_bytes: Buffer.byteLength(FIXTURE_FINAL_BODY),
            response_expires_at_ms: 1_700_604_800_200,
          });
          expect(responses.find((row) => row.attempt_id === '')).toHaveProperty(
            'response_expires_at_ms',
            Number.MAX_SAFE_INTEGER
          );
        }
        if (version === 7) {
          const attempts = migrated.tables.find((table) => table.name === 'request_attempts')!.rows;
          expect(attempts.find((row) => row.attempt_id === '')).toMatchObject({
            originator_identity_id: FIXTURE_IDENTITY_ID,
            attention_revision: 69,
            attention_acknowledged_revision: 0,
          });
          expect(attempts.find((row) => row.attempt_id === 'attempt-003')).toHaveProperty(
            'attention_revision',
            1
          );
        }
        const timestamps = migrationTimestamps(sandbox.database);
        expect(timestamps).toHaveLength(8);
        expect(timestamps.slice(0, version)).toEqual(originalTimestamps);
        for (const timestamp of timestamps) {
          expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        }
        // Reverse compatibility and repeated opens must preserve finals and attention.
        upgradeWithTypeScript(sandbox.database);
        expect((await runStorage(sandbox)).status).toBe(0);
        expect(storageSnapshot(sandbox.database)).toEqual(migrated);
        expect(migrationTimestamps(sandbox.database)).toEqual(timestamps);
      });
    }
  );

  it('lets TypeScript reopen and write a database created only by Rust', async () => {
    await withSandbox(async (sandbox) => {
      expect((await runStorage(sandbox)).status).toBe(0);
      upgradeWithTypeScript(sandbox.database);
      const writer = new Database(sandbox.database);
      try {
        writer
          .prepare('INSERT INTO identities VALUES (?, ?, ?, ?, ?)')
          .run('roundtrip-id', 'Roundtrip', 'roundtrip', 'created', 'updated');
      } finally {
        writer.close();
      }
      const before = storageSnapshot(sandbox.database);
      expect((await runStorage(sandbox)).status).toBe(0);
      expect(storageSnapshot(sandbox.database)).toEqual(before);
    });
  });

  it('converges concurrent native processes on an existing historical WAL database', async () => {
    await withSandbox(async (sandbox) => {
      const reference = path.join(sandbox.root, 'reference', 'state.db');
      seedStoragePrefix(reference, 4);
      seedStoragePrefix(sandbox.database, 4);
      upgradeWithTypeScript(reference);
      // Wait for every bounded child before the sandbox can be removed, even
      // when an individual launch fails. No child may escape failed assertions.
      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () => runStorage(sandbox))
      );
      for (const result of results) {
        expect(result.status).toBe('fulfilled');
        if (result.status === 'fulfilled') {
          expect(result.value.status, result.value.stdout).toBe(0);
          expect(parseWholeStdout(result.value).schemaVersion).toBe(8);
        }
      }
      expect(storageSnapshot(sandbox.database)).toEqual(storageSnapshot(reference));
    });
  });

  it('enforces schema constraints and preserves exchange rows when an identity is removed', async () => {
    await withSandbox(async (sandbox) => {
      expect((await runStorage(sandbox)).status).toBe(0);
      const database = new Database(sandbox.database);
      try {
        database.pragma('foreign_keys = ON');
        database.exec(
          "INSERT INTO identities VALUES ('id', 'Alice', 'alice', 'created', 'updated')"
        );
        expect(() =>
          database.exec(
            "INSERT INTO identities VALUES ('other', 'ALICE', 'alice', 'created', 'updated')"
          )
        ).toThrow(/UNIQUE/);
        expect(() =>
          database.exec("INSERT INTO role_profiles VALUES ('missing', 'body', 'updated')")
        ).toThrow(/FOREIGN KEY/);
        expect(() => database.exec("INSERT INTO preamble_counters VALUES ('id', -1, 1)")).toThrow(
          /CHECK/
        );
        expect(() =>
          database.exec("INSERT INTO request_attention_identities VALUES ('id', 1, 2)")
        ).toThrow(/CHECK/);
        expect(() =>
          database.exec(
            "INSERT INTO request_attention_identities VALUES ('id', 9007199254740992, 0)"
          )
        ).toThrow(/CHECK/);
        database.exec(`
          INSERT INTO role_profiles VALUES ('id', 'body', 'updated');
          INSERT INTO request_attempts (
            attempt_id, request_id, identity_id, server_id, socket_path, server_pid,
            server_start_time, pane_id, pane_pid, wait_active, status,
            inject_preamble, cadence_reserved, prepared_at_ms, expires_at_ms,
            originator_kind, originator_identity_id, attention_revision
          ) VALUES ('attempt', 'request', 'id', 'server', '/socket', 1, 'start', '%1',
            2, 0, 'sent', 0, 0, 1, 2, 'explicit', 'id', 1);
          INSERT INTO request_responses (
            request_id, attempt_id, server_id, socket_path, server_pid, server_start_time,
            pane_id, pane_pid, body, body_bytes, submitted_at_ms
          ) VALUES ('request', 'attempt', 'server', '/socket', 1, 'start', '%1', 2, 'done', 4, 2);
          INSERT INTO request_attention_identities VALUES ('id', 1, 0);
          DELETE FROM identities WHERE id = 'id';
        `);
        expect(database.prepare('SELECT * FROM role_profiles').all()).toEqual([]);
        expect(
          database
            .prepare(
              'SELECT identity_id, originator_identity_id, attention_revision FROM request_attempts'
            )
            .get()
        ).toEqual({
          identity_id: null,
          originator_identity_id: 'id',
          attention_revision: 1,
        });
        expect(database.prepare('SELECT body, body_bytes FROM request_responses').get()).toEqual({
          body: 'done',
          body_bytes: 4,
        });
        expect(database.prepare('SELECT * FROM request_attention_identities').get()).toEqual({
          identity_id: 'id',
          latest_revision: 1,
          acknowledged_through: 0,
        });
      } finally {
        database.close();
      }
      upgradeWithTypeScript(sandbox.database);
    });
  });

  it('rejects a malformed history table without replacing it', async () => {
    await withSandbox(async (sandbox) => {
      seedStoragePrefix(sandbox.database, 0);
      const writer = new Database(sandbox.database);
      try {
        writer.exec(
          'DROP TABLE _migrations; CREATE TABLE _migrations (version TEXT PRIMARY KEY, label TEXT NOT NULL)'
        );
      } finally {
        writer.close();
      }
      const result = await runStorage(sandbox);
      expect(result.status).toBe(1);
      expectError(result, 'incompatible-schema');
      const verification = new Database(sandbox.database, { readonly: true });
      try {
        expect(verification.pragma('table_info(_migrations)')).toMatchObject([
          { name: 'version', type: 'TEXT' },
          { name: 'label', type: 'TEXT' },
        ]);
        expect(verification.prepare('SELECT * FROM _migrations').all()).toEqual([]);
        expect(
          verification.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
        ).toEqual([{ name: '_migrations' }]);
      } finally {
        verification.close();
      }
    });
  });

  it('does not guess migration history for existing domain tables', async () => {
    await withSandbox(async (sandbox) => {
      seedStoragePrefix(sandbox.database, 8);
      const writer = new Database(sandbox.database);
      let identities: unknown;
      let responses: unknown;
      try {
        identities = writer.prepare('SELECT * FROM identities ORDER BY id').all();
        responses = writer.prepare('SELECT * FROM request_responses ORDER BY request_id').all();
        writer.exec('DROP TABLE _migrations');
      } finally {
        writer.close();
      }
      const result = await runStorage(sandbox);
      expect(result.status).toBe(1);
      expect(expectError(result, 'migration').error).toMatchObject({ migrationVersion: 1 });
      const verification = new Database(sandbox.database, { readonly: true });
      try {
        expect(verification.prepare('SELECT * FROM identities ORDER BY id').all()).toEqual(
          identities
        );
        expect(
          verification.prepare('SELECT * FROM request_responses ORDER BY request_id').all()
        ).toEqual(responses);
        // As in TypeScript, history-table initialization may commit, but no
        // version can be fabricated to repair an unsupported existing schema.
        expect(verification.prepare('SELECT * FROM _migrations').all()).toEqual([]);
      } finally {
        verification.close();
      }
    });
  });

  it.each(['renamed', 'gap', 'future'])(
    'rejects %s migration history without resetting or rewriting data',
    async (kind) => {
      await withSandbox(async (sandbox) => {
        seedStoragePrefix(sandbox.database, 8);
        const writer = new Database(sandbox.database);
        try {
          if (kind === 'renamed')
            writer.exec("UPDATE _migrations SET name = 'unknown' WHERE version = 2");
          else if (kind === 'gap') writer.exec('DELETE FROM _migrations WHERE version = 2');
          else writer.exec("INSERT INTO _migrations VALUES (9, 'future', 'timestamp')");
        } finally {
          writer.close();
        }
        const before = storageSnapshot(sandbox.database);
        const result = await runStorage(sandbox);
        expect(result.status).toBe(1);
        expectError(result, 'incompatible-schema');
        expect(storageSnapshot(sandbox.database)).toEqual(before);
      });
    }
  );

  it('rolls back migration 6 on an invalid historical anchor and recovers after explicit repair', async () => {
    await withSandbox(async (sandbox) => {
      seedStoragePrefix(sandbox.database, 5);
      const writer = new Database(sandbox.database);
      try {
        writer.exec('UPDATE request_attempts SET prepared_at_ms = 0');
      } finally {
        writer.close();
      }
      const before = storageSnapshot(sandbox.database);
      const result = await runStorage(sandbox);
      expect(result.status).toBe(1);
      expect(expectError(result, 'migration').error).toMatchObject({
        migrationVersion: 6,
        retryable: false,
      });
      expect(storageSnapshot(sandbox.database)).toEqual(before);
      const repair = new Database(sandbox.database);
      try {
        repair.exec('UPDATE request_attempts SET prepared_at_ms = 1700000000000');
      } finally {
        repair.close();
      }
      expect((await runStorage(sandbox)).status).toBe(0);
      upgradeWithTypeScript(sandbox.database);
    });
  });

  it('reports bounded writer contention and leaves storage usable after lock release', async () => {
    await withSandbox(async (sandbox) => {
      seedStoragePrefix(sandbox.database, 8);
      const before = storageSnapshot(sandbox.database);
      const writer = new Database(sandbox.database);
      try {
        writer.exec('BEGIN IMMEDIATE');
        const result = await runStorage(sandbox);
        expect(result.status).toBe(1);
        expect(expectError(result, 'busy').error).toMatchObject({ retryable: true });
      } finally {
        if (writer.inTransaction) writer.exec('ROLLBACK');
        writer.close();
      }
      expect(storageSnapshot(sandbox.database)).toEqual(before);
      expect((await runStorage(sandbox)).status).toBe(0);
      expect(storageSnapshot(sandbox.database)).toEqual(before);
    });
  }, 15_000);
});
