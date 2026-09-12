import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { resolveCliExecutables } from '../support/cli-executable.mjs';
import {
  expectError,
  parseWholeStdout,
  runCli,
  withSandbox,
  type Sandbox,
} from '../support/cli-process.js';
import {
  FIXTURE_ATTEMPT_COUNT,
  FIXTURE_FINAL_BODY,
  FIXTURE_FINAL_REQUEST_ID,
  FIXTURE_IDENTITY_ID,
  seedStoragePrefix,
  seedStorageReference,
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

function table(snapshot: ReturnType<typeof storageSnapshot>, name: string) {
  const found = snapshot.tables.find((candidate) => candidate.name === name);
  expect(found, `Missing table ${name}`).toBeDefined();
  return found!;
}

function expectNativeSchema10(
  reference: ReturnType<typeof storageSnapshot>,
  migrated: ReturnType<typeof storageSnapshot>
): void {
  expect(migrated.migrations.slice(0, 8)).toEqual(reference.migrations);
  expect(migrated.migrations).toHaveLength(10);
  expect(migrated.migrations[8]).toEqual({
    version: 9,
    name: 'add identity lifetimes and reusable retired names',
  });
  expect(migrated.migrations[9]).toEqual({
    version: 10,
    name: 'add durable identity retirement hooks',
  });
  expect(migrated.tables.map(({ name }) => name)).toEqual(
    [...reference.tables.map(({ name }) => name), 'identity_hooks'].sort()
  );
  const hooks = table(migrated, 'identity_hooks');
  expect(hooks.rows).toEqual([]);
  expect(hooks.columns).toEqual([
    { cid: 0, name: 'consumer', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1 },
    { cid: 1, name: 'identity_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 2 },
    { cid: 2, name: 'reference', type: 'TEXT', notnull: 1, dflt_value: null, pk: 3 },
    { cid: 3, name: 'state', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    { cid: 4, name: 'attempt_count', type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 },
  ]);
  expect(hooks.foreignKeys).toEqual([
    {
      id: 0,
      seq: 0,
      table: 'identities',
      from: 'identity_id',
      to: 'id',
      on_update: 'NO ACTION',
      on_delete: 'NO ACTION',
      match: 'NONE',
    },
  ]);
  expect(hooks.indexes).toHaveLength(3);
  const queueIndex = hooks.indexes.find((index) => index.name === 'identity_hooks_pending');
  expect(queueIndex).toMatchObject({ unique: 0, partial: 0, origin: 'c' });
  expect(
    queueIndex?.columns.filter((column) => column.key === 1).map((column) => column.name)
  ).toEqual(['consumer', 'state', 'attempt_count', 'identity_id', 'reference']);
  const retirementIndex = hooks.indexes.find((index) => index.name === 'identity_hooks_retirement');
  expect(retirementIndex).toMatchObject({ unique: 0, partial: 0, origin: 'c' });
  expect(
    retirementIndex?.columns.filter((column) => column.key === 1).map((column) => column.name)
  ).toEqual(['identity_id', 'state']);

  const unchangedTables = reference.tables
    .filter(({ name }) => name !== '_migrations' && name !== 'identities')
    .map(({ name }) => name);
  expect(
    migrated.tables.filter(({ name }) => unchangedTables.includes(name)).map(({ name }) => name)
  ).toEqual(unchangedTables);
  for (const name of unchangedTables) expect(table(migrated, name)).toEqual(table(reference, name));

  const oldHistory = table(reference, '_migrations');
  const newHistory = table(migrated, '_migrations');
  expect(newHistory.columns).toEqual(oldHistory.columns);
  expect(newHistory.indexes).toEqual(oldHistory.indexes);
  expect(newHistory.foreignKeys).toEqual(oldHistory.foreignKeys);
  expect(newHistory.rows).toEqual([
    ...oldHistory.rows,
    { version: 9, name: migrated.migrations[8]!.name },
    { version: 10, name: migrated.migrations[9]!.name },
  ]);

  const oldIdentities = table(reference, 'identities');
  const newIdentities = table(migrated, 'identities');
  expect(newIdentities.columns.slice(0, 5)).toEqual(oldIdentities.columns);
  expect(newIdentities.columns.slice(5)).toEqual([
    { cid: 5, name: 'lifetime', type: 'TEXT', notnull: 1, dflt_value: "'saved'", pk: 0 },
    { cid: 6, name: 'retired_at_ms', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
  ]);
  expect(newIdentities.rows).toEqual(
    oldIdentities.rows.map((row) => ({ ...row, lifetime: 'saved', retired_at_ms: null }))
  );
  expect(newIdentities.foreignKeys).toEqual(oldIdentities.foreignKeys);
  expect(newIdentities.indexes).toHaveLength(oldIdentities.indexes.length);
  expect(newIdentities.indexes.find((index) => index.origin === 'pk')).toEqual(
    oldIdentities.indexes.find((index) => index.origin === 'pk')
  );
  const activeNameIndex = newIdentities.indexes.find(
    (index) =>
      index.unique === 1 &&
      index.partial === 1 &&
      index.columns.some((column) => column.name === 'canonical_name' && column.key === 1)
  );
  expect(activeNameIndex).toMatchObject({ name: 'identities_active_name' });
  expect(
    newIdentities.indexes.some(
      (index) =>
        index.unique === 1 &&
        index.partial === 0 &&
        index.columns.some((column) => column.name === 'canonical_name' && column.key === 1)
    )
  ).toBe(false);
}

describe('native SQLite lifecycle compatibility', () => {
  it.each(Array.from({ length: 9 }, (_, version) => version))(
    'upgrades closed TypeScript schema %i to schema 10 without changing durable data',
    async (version) => {
      await withSandbox(async (sandbox) => {
        const reference = path.join(sandbox.root, 'reference', 'state.db');
        seedStorageReference(reference, version);
        seedStoragePrefix(sandbox.database, version);
        const originalTimestamps = migrationTimestamps(sandbox.database);

        const result = await runStorage(sandbox);
        expect(result.status).toBe(0);
        expect(parseWholeStdout(result)).toEqual({
          path: sandbox.database,
          open: true,
          schemaVersion: 10,
          journalMode: 'wal',
          foreignKeys: true,
          busyTimeoutMs: 5000,
          synchronous: 'normal',
          fts5: true,
        });
        const migrated = storageSnapshot(sandbox.database);
        expectNativeSchema10(storageSnapshot(reference), migrated);
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
        expect(timestamps).toHaveLength(10);
        expect(timestamps.slice(0, version)).toEqual(originalTimestamps);
        for (const timestamp of timestamps) {
          expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        }
        expect((await runStorage(sandbox)).status).toBe(0);
        expect(storageSnapshot(sandbox.database)).toEqual(migrated);
        expect(migrationTimestamps(sandbox.database)).toEqual(timestamps);
      });
    }
  );

  it('converges concurrent native processes on an existing historical WAL database', async () => {
    await withSandbox(async (sandbox) => {
      const reference = path.join(sandbox.root, 'reference', 'state.db');
      seedStorageReference(reference, 8);
      seedStoragePrefix(sandbox.database, 8);
      // Wait for every bounded child before the sandbox can be removed, even
      // when an individual launch fails. No child may escape failed assertions.
      const results = await Promise.allSettled(
        Array.from({ length: 4 }, () => runStorage(sandbox))
      );
      for (const result of results) {
        expect(result.status).toBe('fulfilled');
        if (result.status === 'fulfilled') {
          expect(result.value.status, result.value.stdout).toBe(0);
          expect(parseWholeStdout(result.value).schemaVersion).toBe(10);
        }
      }
      expectNativeSchema10(storageSnapshot(reference), storageSnapshot(sandbox.database));
    });
  });

  it('enforces retirement subscription uniqueness, foreign keys and delivery state bounds', async () => {
    await withSandbox(async (sandbox) => {
      expect((await runStorage(sandbox)).status).toBe(0);
      const database = new Database(sandbox.database);
      try {
        database.pragma('foreign_keys = ON');
        database.exec(
          "INSERT INTO identities (id, name, canonical_name, created_at, updated_at) VALUES ('hook-id', 'Agent', 'agent', 'created', 'updated')"
        );
        const insert = database.prepare(
          'INSERT INTO identity_hooks (consumer, identity_id, reference, state, attempt_count) VALUES (?, ?, ?, ?, ?)'
        );
        insert.run('office', 'hook-id', 'scope', 'registered', 0);
        expect(() => insert.run('office', 'hook-id', 'scope', 'pending', 0)).toThrow(/UNIQUE/);
        expect(() => insert.run('office', 'missing', 'scope', 'registered', 0)).toThrow(
          /FOREIGN KEY/
        );
        for (const state of ['unknown', '']) {
          expect(() => insert.run('office', 'hook-id', 'other', state, 0)).toThrow(/CHECK/);
        }
        for (const attempt of [-1, 0.5]) {
          expect(() => insert.run('office', 'hook-id', 'other', 'pending', attempt)).toThrow(
            /CHECK/
          );
        }
        expect(() => insert.run('', 'hook-id', 'other', 'registered', 0)).toThrow(/CHECK/);
        expect(() => insert.run('a'.repeat(65), 'hook-id', 'other', 'registered', 0)).toThrow(
          /CHECK/
        );
        expect(() => insert.run('office', 'hook-id', '', 'registered', 0)).toThrow(/CHECK/);
        expect(() => insert.run('office', 'hook-id', 'a'.repeat(257), 'registered', 0)).toThrow(
          /CHECK/
        );
        // Different consumers and references remain separate subscriptions.
        insert.run('another', 'hook-id', 'scope', 'pending', 1);
        insert.run('office', 'hook-id', 'other', 'delivered', 2);
        expect(
          database
            .prepare(
              'SELECT consumer, reference, state, attempt_count FROM identity_hooks ORDER BY consumer, reference'
            )
            .all()
        ).toEqual([
          { consumer: 'another', reference: 'scope', state: 'pending', attempt_count: 1 },
          { consumer: 'office', reference: 'other', state: 'delivered', attempt_count: 2 },
          { consumer: 'office', reference: 'scope', state: 'registered', attempt_count: 0 },
        ]);
        expect(() => database.exec("DELETE FROM identities WHERE id = 'hook-id'")).toThrow(
          /FOREIGN KEY/
        );
      } finally {
        database.close();
      }
    });
  });

  it('enforces schema constraints and preserves exchange rows when an identity is removed', async () => {
    await withSandbox(async (sandbox) => {
      expect((await runStorage(sandbox)).status).toBe(0);
      const database = new Database(sandbox.database);
      try {
        database.pragma('foreign_keys = ON');
        database.exec(
          "INSERT INTO identities (id, name, canonical_name, created_at, updated_at) VALUES ('id', 'Alice', 'alice', 'created', 'updated')"
        );
        expect(
          database.prepare('SELECT lifetime, retired_at_ms FROM identities WHERE id = ?').get('id')
        ).toEqual({
          lifetime: 'saved',
          retired_at_ms: null,
        });
        expect(() =>
          database.exec(
            "INSERT INTO identities (id, name, canonical_name, created_at, updated_at) VALUES ('other', 'ALICE', 'alice', 'created', 'updated')"
          )
        ).toThrow(/UNIQUE/);
        expect(() =>
          database.exec(
            "INSERT INTO identities VALUES ('invalid-lifetime', 'Invalid', 'invalid-lifetime', 'created', 'updated', 'permanent', NULL)"
          )
        ).toThrow(/CHECK/);
        expect(() =>
          database.exec(
            "INSERT INTO identities VALUES ('invalid-retired-zero', 'Invalid', 'invalid-retired-zero', 'created', 'updated', 'saved', 0)"
          )
        ).toThrow(/CHECK/);
        expect(() =>
          database.exec(
            "INSERT INTO identities VALUES ('invalid-retired-large', 'Invalid', 'invalid-retired-large', 'created', 'updated', 'saved', 9007199254740992)"
          )
        ).toThrow(/CHECK/);
        database.exec(
          "UPDATE identities SET lifetime = 'temporary', retired_at_ms = 9007199254740991 WHERE id = 'id'"
        );
        database.exec(
          "INSERT INTO identities VALUES ('new-id', 'ALICE', 'alice', 'created-new', 'updated-new', 'saved', NULL)"
        );
        expect(
          database.prepare('SELECT id, lifetime, retired_at_ms FROM identities ORDER BY id').all()
        ).toEqual([
          { id: 'id', lifetime: 'temporary', retired_at_ms: Number.MAX_SAFE_INTEGER },
          { id: 'new-id', lifetime: 'saved', retired_at_ms: null },
        ]);
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
    });
  });

  it('rolls back schema 9 identity replacement when recording the migration fails', async () => {
    await withSandbox(async (sandbox) => {
      seedStoragePrefix(sandbox.database, 8);
      const before = storageSnapshot(sandbox.database);
      const writer = new Database(sandbox.database);
      try {
        writer.exec(`
          CREATE TRIGGER fail_schema9_history
          BEFORE INSERT ON _migrations
          WHEN NEW.version = 9
          BEGIN
            SELECT RAISE(ABORT, 'schema 9 history failure');
          END;
        `);
      } finally {
        writer.close();
      }

      const failed = await runStorage(sandbox);
      expect(failed.status).toBe(1);
      expect(expectError(failed, 'migration').error).toMatchObject({ migrationVersion: 9 });
      expect(storageSnapshot(sandbox.database)).toEqual(before);
      const afterFailure = new Database(sandbox.database, { readonly: true });
      try {
        expect(
          afterFailure
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND name = ?")
            .get('fail_schema9_history')
        ).toEqual({ name: 'fail_schema9_history' });
      } finally {
        afterFailure.close();
      }

      const repair = new Database(sandbox.database);
      try {
        repair.exec('DROP TRIGGER fail_schema9_history');
      } finally {
        repair.close();
      }
      expect((await runStorage(sandbox)).status).toBe(0);
      expect(parseWholeStdout(await runStorage(sandbox))).toMatchObject({ schemaVersion: 10 });
    });
  });

  it('rejects an invalid old foreign key without replacing the identity table', async () => {
    await withSandbox(async (sandbox) => {
      seedStoragePrefix(sandbox.database, 8);
      const writer = new Database(sandbox.database);
      try {
        writer.pragma('foreign_keys = OFF');
        writer
          .prepare('INSERT INTO role_profiles (identity_id, content, updated_at) VALUES (?, ?, ?)')
          .run('missing-old-identity', 'orphan role', 'updated');
      } finally {
        writer.close();
      }
      const before = storageSnapshot(sandbox.database);
      const result = await runStorage(sandbox);
      expect(result.status).toBe(1);
      expect(expectError(result, 'migration').error).toMatchObject({ migrationVersion: 9 });
      expect(storageSnapshot(sandbox.database)).toEqual(before);
    });
  });

  it('rejects an unexpected identity index without replacing the identity table', async () => {
    await withSandbox(async (sandbox) => {
      seedStoragePrefix(sandbox.database, 8);
      const writer = new Database(sandbox.database);
      try {
        writer.exec('CREATE INDEX identities_unexpected_name ON identities(name)');
      } finally {
        writer.close();
      }
      const before = storageSnapshot(sandbox.database);
      const result = await runStorage(sandbox);
      expect(result.status).toBe(1);
      expect(expectError(result, 'migration').error).toMatchObject({ migrationVersion: 9 });
      expect(storageSnapshot(sandbox.database)).toEqual(before);
    });
  });

  it('preserves old UUID provenance and gives a reused name no dependent rows', async () => {
    await withSandbox(async (sandbox) => {
      seedStoragePrefix(sandbox.database, 8);
      expect((await runStorage(sandbox)).status).toBe(0);
      const before = storageSnapshot(sandbox.database);
      const database = new Database(sandbox.database);
      try {
        database.pragma('foreign_keys = ON');
        database
          .prepare("UPDATE identities SET lifetime = 'temporary', retired_at_ms = ? WHERE id = ?")
          .run(1_700_000_000_999, FIXTURE_IDENTITY_ID);
        database
          .prepare(
            `INSERT INTO identities (
               id, name, canonical_name, created_at, updated_at, lifetime, retired_at_ms
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            'identity-new',
            'Known Fixture',
            'known-fixture',
            '2026-02-01T00:00:00.000Z',
            '2026-02-01T00:00:00.000Z',
            'saved',
            null
          );

        expect(
          database
            .prepare(
              `SELECT DISTINCT identity_id, originator_identity_id, recipient_identity_id
               FROM request_attempts
               WHERE identity_id = ? OR originator_identity_id = ? OR recipient_identity_id = ?`
            )
            .all(FIXTURE_IDENTITY_ID, FIXTURE_IDENTITY_ID, FIXTURE_IDENTITY_ID)
        ).not.toHaveLength(0);
        expect(
          database
            .prepare(
              `SELECT COUNT(*) AS count FROM request_attempts
               WHERE identity_id = ? OR originator_identity_id = ? OR recipient_identity_id = ?`
            )
            .get('identity-new', 'identity-new', 'identity-new')
        ).toEqual({ count: 0 });
        for (const tableName of [
          'bindings',
          'identity_preambles',
          'preamble_counters',
          'request_attention_identities',
          'role_profiles',
        ]) {
          expect(
            database
              .prepare(`SELECT COUNT(*) AS count FROM ${tableName} WHERE identity_id = ?`)
              .get('identity-new')
          ).toEqual({ count: 0 });
        }
        expect(
          database.prepare('SELECT id FROM bindings WHERE identity_id = ?').get(FIXTURE_IDENTITY_ID)
        ).toEqual({ id: 'binding-known' });
        expect(
          database
            .prepare(
              'SELECT identity_id FROM request_attempts WHERE originator_identity_id = ? LIMIT 1'
            )
            .get(FIXTURE_IDENTITY_ID)
        ).toEqual({ identity_id: FIXTURE_IDENTITY_ID });
      } finally {
        database.close();
      }
      const after = storageSnapshot(sandbox.database);
      expect(after.tables.filter(({ name }) => name !== 'identities')).toEqual(
        before.tables.filter(({ name }) => name !== 'identities')
      );
      const identities = new Database(sandbox.database, { readonly: true });
      try {
        expect(
          identities
            .prepare(
              'SELECT id, lifetime, retired_at_ms FROM identities WHERE canonical_name = ? ORDER BY id'
            )
            .all('known-fixture')
        ).toEqual([
          { id: FIXTURE_IDENTITY_ID, lifetime: 'temporary', retired_at_ms: 1_700_000_000_999 },
          { id: 'identity-new', lifetime: 'saved', retired_at_ms: null },
        ]);
      } finally {
        identities.close();
      }
    });
  });

  it('preserves a user table that conflicts with the migration replacement name', async () => {
    await withSandbox(async (sandbox) => {
      seedStoragePrefix(sandbox.database, 8);
      const writer = new Database(sandbox.database);
      try {
        writer.exec(`
          CREATE TABLE identities_with_lifetime (note TEXT NOT NULL);
          INSERT INTO identities_with_lifetime VALUES ('user-owned content');
        `);
      } finally {
        writer.close();
      }
      const before = storageSnapshot(sandbox.database);
      const result = await runStorage(sandbox);
      expect(result.status).toBe(1);
      expect(expectError(result, 'migration').error).toMatchObject({ migrationVersion: 9 });
      expect(storageSnapshot(sandbox.database)).toEqual(before);
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
        if (kind === 'future') {
          const upgraded = await runStorage(sandbox);
          expect(upgraded.status).toBe(0);
          expect(parseWholeStdout(upgraded)).toMatchObject({ schemaVersion: 10 });
        }
        const writer = new Database(sandbox.database);
        try {
          if (kind === 'renamed')
            writer.exec("UPDATE _migrations SET name = 'unknown' WHERE version = 2");
          else if (kind === 'gap') writer.exec('DELETE FROM _migrations WHERE version = 2');
          else writer.exec("INSERT INTO _migrations VALUES (11, 'future', 'timestamp')");
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
    });
  });

  it('reports bounded writer contention and leaves storage usable after lock release', async () => {
    await withSandbox(async (sandbox) => {
      const reference = path.join(sandbox.root, 'reference', 'state.db');
      seedStorageReference(reference, 8);
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
      expectNativeSchema10(storageSnapshot(reference), storageSnapshot(sandbox.database));
    });
  }, 15_000);
});
