import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createRequestService } from '../request-service.js';
import { CURRENT_MIGRATIONS } from './migrations.js';
import { openIdentityRepository } from './identity-repository.js';
import { openStorageWithMigrations } from './sqlite-adapter.js';

const directories: string[] = [];

function databaseFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-attention-migration-'));
  directories.push(directory);
  return path.join(directory, 'tmux-team.db');
}

function location(databaseFile: string): { globalDir: string; databaseFile: string } {
  return { globalDir: path.dirname(databaseFile), databaseFile };
}

function v7Snapshot(file: string): {
  readonly identities: unknown[];
  readonly attempts: unknown[];
  readonly responses: unknown[];
  readonly migrations: unknown[];
} {
  const database = new Database(file, { readonly: true });
  try {
    return {
      identities: database
        .prepare(
          `SELECT id, name, canonical_name, created_at, updated_at
           FROM identities ORDER BY id`
        )
        .all(),
      attempts: database
        .prepare(
          `SELECT attempt_id, request_id, originator_kind, originator_identity_id,
                  recipient_identity_id, nonce, identity_id, server_id, socket_path,
                  server_pid, server_start_time, pane_id, pane_pid, wait_active, status,
                  preamble_every, inject_preamble, cadence_reserved, prepared_at_ms,
                  sending_at_ms, settled_at_ms, wait_released_at_ms,
                  response_submitted_at_ms, expires_at_ms, retention_days,
                  retention_expires_at_ms, message_text, message_bytes, message_expires_at_ms
           FROM request_attempts ORDER BY attempt_id`
        )
        .all(),
      responses: database
        .prepare(
          `SELECT request_id, attempt_id, server_id, socket_path, server_pid,
                  server_start_time, pane_id, pane_pid, body, body_bytes,
                  submitted_at_ms, response_expires_at_ms
           FROM request_responses ORDER BY request_id`
        )
        .all(),
      migrations: database.prepare('SELECT version, name FROM _migrations ORDER BY version').all(),
    };
  } finally {
    database.close();
  }
}

function seedSchema7(file: string): void {
  const storage = openStorageWithMigrations(location(file), CURRENT_MIGRATIONS.slice(0, 7));
  storage.close();
  const database = new Database(file);
  try {
    database
      .prepare(
        `INSERT INTO identities (id, name, canonical_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run('identity-known', 'Known', 'known', '2026-01-01', '2026-01-01');
    const insert = database.prepare(
      `INSERT INTO request_attempts (
         attempt_id, request_id, originator_kind, originator_identity_id,
         recipient_identity_id, nonce, identity_id, server_id, socket_path, server_pid,
         server_start_time, pane_id, pane_pid, wait_active, status, preamble_every,
         inject_preamble, cadence_reserved, prepared_at_ms, sending_at_ms, settled_at_ms,
         wait_released_at_ms, response_submitted_at_ms, expires_at_ms, retention_days,
         retention_expires_at_ms, message_text, message_bytes, message_expires_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const common = [
      'recipient-id',
      'nonce',
      null,
      'server',
      '/tmp/server',
      101,
      'start',
      '%1',
      202,
      0,
      'prepared',
      null,
      0,
      0,
      10_000,
      null,
      null,
      null,
      null,
      10_000 + 60 * 60 * 1000,
      90,
      10_000 + 90 * 24 * 60 * 60 * 1000,
      null,
      null,
      null,
    ] as const;
    insert.run('attempt-b', 'request-b', 'explicit', 'identity-known', ...common);
    insert.run(
      'attempt-a',
      'request-a',
      'explicit',
      'identity-known',
      ...common.slice(0, 14),
      9_000,
      ...common.slice(15)
    );
    insert.run('attempt-u', 'request-u', 'unknown', null, ...common);
    insert.run('attempt-m', 'request-m', 'verified', 'identity-missing', ...common);
    database
      .prepare(
        `UPDATE request_attempts
         SET message_text = ?, message_bytes = ?, message_expires_at_ms = ?,
             status = 'sent', settled_at_ms = ?, response_submitted_at_ms = ?,
             retention_expires_at_ms = ?
         WHERE attempt_id = 'attempt-a'`
      )
      .run(
        'migrated prompt',
        Buffer.byteLength('migrated prompt'),
        20_000,
        9_000,
        9_000,
        9_000 + 90 * 24 * 60 * 60 * 1000
      );
    database
      .prepare(
        `INSERT INTO request_responses (
           request_id, attempt_id, server_id, socket_path, server_pid, server_start_time,
           pane_id, pane_pid, body, body_bytes, submitted_at_ms, response_expires_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'request-a',
        'attempt-a',
        'server',
        '/tmp/server',
        101,
        'start',
        '%1',
        202,
        'migrated final',
        Buffer.byteLength('migrated final'),
        9_000,
        9_000 + 90 * 24 * 60 * 60 * 1000
      );
    database
      .prepare('UPDATE request_attempts SET prepared_at_ms = 9_000 WHERE attempt_id = ?')
      .run('attempt-b');
  } finally {
    database.close();
  }
}

afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('exchange attention migration', () => {
  it('backfills known provenance deterministically and leaves anonymous rows at revision zero', () => {
    const file = databaseFile();
    seedSchema7(file);
    const storage = openStorageWithMigrations(location(file), CURRENT_MIGRATIONS);
    storage.close();
    const database = new Database(file, { readonly: true });
    try {
      expect(
        database
          .prepare(
            `SELECT request_id, attention_revision, attention_acknowledged_revision
             FROM request_attempts ORDER BY request_id`
          )
          .all()
      ).toEqual([
        { request_id: 'request-a', attention_revision: 1, attention_acknowledged_revision: 0 },
        { request_id: 'request-b', attention_revision: 2, attention_acknowledged_revision: 0 },
        { request_id: 'request-m', attention_revision: 1, attention_acknowledged_revision: 0 },
        { request_id: 'request-u', attention_revision: 0, attention_acknowledged_revision: 0 },
      ]);
      expect(database.prepare('SELECT * FROM request_attention_identities').all()).toEqual([
        { identity_id: 'identity-known', latest_revision: 2, acknowledged_through: 0 },
        { identity_id: 'identity-missing', latest_revision: 1, acknowledged_through: 0 },
      ]);
      expect(
        database.prepare('PRAGMA foreign_key_list(request_attention_identities)').all()
      ).toEqual([]);
    } finally {
      database.close();
    }
    const repository = openIdentityRepository(file);
    try {
      const service = createRequestService({ repository, now: () => 10_000 });
      expect(service.showExchange('identity-known', 'request-a')).toMatchObject({
        revision: 1,
        prompt: { status: 'retained', message: 'migrated prompt' },
        final: { status: 'retained', response: 'migrated final' },
      });
    } finally {
      repository.close();
    }
  });

  it('rejects fractional attention revisions and invalid acknowledgement watermarks', () => {
    const file = databaseFile();
    const storage = openStorageWithMigrations(location(file), CURRENT_MIGRATIONS);
    storage.close();
    const database = new Database(file);
    try {
      expect(() =>
        database
          .prepare(
            `INSERT INTO request_attention_identities (identity_id, latest_revision, acknowledged_through)
             VALUES ('fractional', 1.5, 0)`
          )
          .run()
      ).toThrow();
      expect(() =>
        database
          .prepare(
            `INSERT INTO request_attention_identities (identity_id, latest_revision, acknowledged_through)
             VALUES ('ahead', 1, 2)`
          )
          .run()
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it('rolls back a failed v8 migration without changing v7 data or migration history', () => {
    const file = databaseFile();
    seedSchema7(file);
    const before = v7Snapshot(file);
    const migration8 = CURRENT_MIGRATIONS[7]!;
    let completedMigrationBody = false;
    const failingMigrations = [
      ...CURRENT_MIGRATIONS.slice(0, 7),
      {
        ...migration8,
        up(database: Database.Database) {
          migration8.up(database);
          completedMigrationBody = true;
          throw new Error('injected attention migration failure');
        },
      },
    ];

    expect(() => openStorageWithMigrations(location(file), failingMigrations)).toThrow(
      expect.objectContaining({ code: 'migration', migrationVersion: 8 })
    );
    expect(completedMigrationBody).toBe(true);
    const afterFailure = v7Snapshot(file);
    expect(afterFailure).toEqual(before);
    const failedDatabase = new Database(file, { readonly: true });
    try {
      expect(
        failedDatabase
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'request_attention_identities'"
          )
          .get()
      ).toBeUndefined();
      expect(
        failedDatabase
          .prepare('PRAGMA table_info(request_attempts)')
          .all()
          .map((column) => (column as { name: string }).name)
      ).not.toContain('attention_revision');
    } finally {
      failedDatabase.close();
    }

    const firstOpen = openStorageWithMigrations(location(file), CURRENT_MIGRATIONS);
    firstOpen.close();
    const afterSuccess = v7Snapshot(file);
    expect(afterSuccess.identities).toEqual(before.identities);
    expect(afterSuccess.attempts).toEqual(before.attempts);
    expect(afterSuccess.responses).toEqual(before.responses);
    expect(afterSuccess.migrations).toHaveLength(8);
    const secondOpen = openStorageWithMigrations(location(file), CURRENT_MIGRATIONS);
    secondOpen.close();
    expect(v7Snapshot(file).migrations).toEqual(afterSuccess.migrations);
  });

  it('enforces integer and safe-range checks on both request revision columns', () => {
    const file = databaseFile();
    seedSchema7(file);
    const storage = openStorageWithMigrations(location(file), CURRENT_MIGRATIONS);
    storage.close();
    const database = new Database(file);
    try {
      for (const value of ['1.5', '-1', '9007199254740992']) {
        expect(() =>
          database
            .prepare('UPDATE request_attempts SET attention_revision = ? WHERE attempt_id = ?')
            .run(value, 'attempt-u')
        ).toThrow();
        expect(() =>
          database
            .prepare(
              'UPDATE request_attempts SET attention_acknowledged_revision = ? WHERE attempt_id = ?'
            )
            .run(value, 'attempt-u')
        ).toThrow();
      }
    } finally {
      database.close();
    }
  });
});
