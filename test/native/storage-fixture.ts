import Database from 'better-sqlite3';
import path from 'node:path';
import { openStorageWithMigrations } from '../../src/storage/sqlite-adapter.js';
import { CURRENT_MIGRATIONS } from '../../src/storage/migrations.js';

export const FIXTURE_IDENTITY_ID = 'identity-known';
export const FIXTURE_MISSING_IDENTITY_ID = 'identity-missing';
export const FIXTURE_ATTEMPT_COUNT = 205;
export const FIXTURE_PREPARED_AT_MS = 1_700_000_000_000;
export const FIXTURE_SATURATION_AT_MS = Number.MAX_SAFE_INTEGER - 1;
export const FIXTURE_FINAL_REQUEST_ID = 'request-final';
export const FIXTURE_FINAL_BODY = 'fixture final response';

const FIXTURE_SOCKET_PATH = '/tmp/tmt-fixture.sock';
const FIXTURE_SERVER_ID = 'fixture-server';
const FIXTURE_SERVER_START_TIME = 'fixture-server-start';
const FIXTURE_SERVER_PID = 101;
const FIXTURE_PANE_ID = '%7';
const FIXTURE_PANE_PID = 202;
const FIXTURE_RETENTION_EXPIRES_AT_MS = 1_700_604_800_000;
const FIXTURE_FINAL_SUBMITTED_AT_MS = 1_700_000_000_200;
const FIXTURE_FINAL_EXPIRES_AT_MS = 1_700_604_800_200;

type FixtureVersion = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

interface FixtureAttempt {
  readonly attemptId: string;
  readonly requestId: string;
  readonly identityId: string | null;
  readonly originatorKind: 'unknown' | 'explicit' | 'verified';
  readonly originatorIdentityId: string | null;
  readonly recipientIdentityId: string | null;
  readonly preparedAtMs: number;
  readonly status: 'prepared' | 'sending' | 'sent' | 'uncertain';
  readonly waitActive: number;
  readonly preambleEvery: number | null;
  readonly injectPreamble: number;
  readonly cadenceReserved: number;
  readonly messageText: string | null;
  readonly messageBytes: number | null;
  readonly messageExpiresAtMs: number | null;
  readonly attentionRevision: number;
}

export interface StorageSnapshot {
  readonly migrations: readonly MigrationSnapshot[];
  readonly tables: readonly TableSnapshot[];
}

interface MigrationSnapshot {
  readonly version: number;
  readonly name: string;
}

interface TableSnapshot {
  readonly name: string;
  readonly columns: readonly Record<string, unknown>[];
  readonly indexes: readonly IndexSnapshot[];
  readonly foreignKeys: readonly Record<string, unknown>[];
  readonly rows: readonly Record<string, unknown>[];
}

interface IndexSnapshot {
  readonly name: string;
  readonly columns: readonly Record<string, unknown>[];
  readonly unique: number;
  readonly origin: string;
  readonly partial: number;
}

const PRIMARY_KEY_ORDER: Record<string, readonly string[]> = {
  _migrations: ['version'],
  bindings: ['id'],
  identities: ['id'],
  identity_preambles: ['identity_id'],
  preamble_counters: ['identity_id'],
  request_attempts: ['attempt_id'],
  request_attention_identities: ['identity_id'],
  request_responses: ['request_id'],
  role_profiles: ['identity_id'],
};

function location(file: string): { globalDir: string; databaseFile: string } {
  return { globalDir: path.dirname(file), databaseFile: file };
}

function fixtureVersion(version: number): FixtureVersion {
  if (!Number.isInteger(version) || version < 0 || version > 8) {
    throw new Error('Fixture migration version must be between 0 and 8.');
  }
  return version as FixtureVersion;
}

function openPrefix(file: string, version: FixtureVersion): void {
  const storage = openStorageWithMigrations(location(file), CURRENT_MIGRATIONS.slice(0, version));
  try {
    storage.checkpoint('passive');
  } finally {
    storage.close();
  }
}

function makeAttempts(version: FixtureVersion): FixtureAttempt[] {
  const attempts: FixtureAttempt[] = [];
  for (let index = 0; index < FIXTURE_ATTEMPT_COUNT; index += 1) {
    const attemptId = index === 0 ? '' : `attempt-${String(index).padStart(3, '0')}`;
    const group = index % 3;
    const originatorIdentityId =
      version >= 7
        ? group === 0
          ? FIXTURE_IDENTITY_ID
          : group === 1
            ? FIXTURE_MISSING_IDENTITY_ID
            : null
        : null;
    const originatorKind =
      version >= 7 ? (group === 0 ? 'explicit' : group === 1 ? 'verified' : 'unknown') : 'unknown';
    const preparedAtMs = index === 0 ? FIXTURE_SATURATION_AT_MS : FIXTURE_PREPARED_AT_MS + index;
    const status = (['prepared', 'sending', 'sent', 'uncertain'] as const)[index % 4]!;
    const messageText = version >= 7 && group !== 2 ? `prompt-${group}` : null;
    attempts.push({
      attemptId,
      requestId:
        index === 1 ? FIXTURE_FINAL_REQUEST_ID : `request-${String(index).padStart(3, '0')}`,
      identityId: version >= 4 && group === 0 ? FIXTURE_IDENTITY_ID : null,
      originatorKind,
      originatorIdentityId,
      recipientIdentityId: version >= 7 && group === 0 ? FIXTURE_IDENTITY_ID : null,
      preparedAtMs,
      status,
      waitActive: status === 'prepared' || status === 'sending' ? 1 : 0,
      preambleEvery: version >= 4 && group === 0 ? 3 : null,
      injectPreamble: version >= 4 && group === 0 ? 1 : 0,
      cadenceReserved: version >= 4 && group === 0 ? 1 : 0,
      messageText,
      messageBytes: messageText === null ? null : Buffer.byteLength(messageText),
      messageExpiresAtMs: messageText === null ? null : FIXTURE_RETENTION_EXPIRES_AT_MS,
      attentionRevision: 0,
    });
  }
  const groupCounts = new Map<string, number>();
  for (const attempt of [...attempts].sort(
    (left, right) =>
      left.preparedAtMs - right.preparedAtMs || left.requestId.localeCompare(right.requestId)
  )) {
    if (attempt.originatorIdentityId === null) continue;
    const revision = (groupCounts.get(attempt.originatorIdentityId) ?? 0) + 1;
    groupCounts.set(attempt.originatorIdentityId, revision);
    const index = attempts.indexOf(attempt);
    attempts[index] = { ...attempt, attentionRevision: revision };
  }
  return attempts;
}

function seedRows(database: Database.Database, version: FixtureVersion): void {
  if (version >= 1) {
    database
      .prepare(
        `INSERT INTO identities (id, name, canonical_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        FIXTURE_IDENTITY_ID,
        'Known Fixture',
        'known-fixture',
        '2026-01-01T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z'
      );
    database
      .prepare(
        `INSERT INTO bindings (
           id, identity_id, transport, pane_id, server_id, socket_path, server_pid,
           server_start_time, pane_pid, bound_at, last_verified_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'binding-known',
        FIXTURE_IDENTITY_ID,
        'tmux',
        FIXTURE_PANE_ID,
        FIXTURE_SERVER_ID,
        FIXTURE_SOCKET_PATH,
        FIXTURE_SERVER_PID,
        FIXTURE_SERVER_START_TIME,
        FIXTURE_PANE_PID,
        '2026-01-02T00:00:00.000Z',
        '2026-01-02T00:00:01.000Z'
      );
  }
  if (version >= 2) {
    database
      .prepare('INSERT INTO role_profiles (identity_id, content, updated_at) VALUES (?, ?, ?)')
      .run(FIXTURE_IDENTITY_ID, 'fixture role profile', '2026-01-02T00:00:02.000Z');
  }
  if (version >= 3) {
    database
      .prepare('INSERT INTO identity_preambles (identity_id, content, updated_at) VALUES (?, ?, ?)')
      .run(FIXTURE_IDENTITY_ID, 'fixture preamble', '2026-01-02T00:00:03.000Z');
  }
  if (version < 4) return;

  database
    .prepare(
      'INSERT INTO preamble_counters (identity_id, reserved_count, updated_at_ms) VALUES (?, ?, ?)'
    )
    .run(FIXTURE_IDENTITY_ID, 7, FIXTURE_PREPARED_AT_MS);

  const attempts = makeAttempts(version);
  const attemptColumns = [
    'attempt_id',
    'request_id',
    'nonce',
    'identity_id',
    'server_id',
    'socket_path',
    'server_pid',
    'server_start_time',
    'pane_id',
    'pane_pid',
    'wait_active',
    'status',
    'preamble_every',
    'inject_preamble',
    'cadence_reserved',
    'prepared_at_ms',
    'sending_at_ms',
    'settled_at_ms',
    'wait_released_at_ms',
    ...(version >= 5 ? ['response_submitted_at_ms'] : []),
    'expires_at_ms',
    ...(version >= 6 ? ['retention_days', 'retention_expires_at_ms'] : []),
    ...(version >= 7
      ? [
          'originator_kind',
          'originator_identity_id',
          'recipient_identity_id',
          'message_text',
          'message_bytes',
          'message_expires_at_ms',
        ]
      : []),
    ...(version >= 8 ? ['attention_revision', 'attention_acknowledged_revision'] : []),
  ];
  const insertAttempt = database.prepare(
    `INSERT INTO request_attempts (${attemptColumns.join(', ')})
     VALUES (${attemptColumns.map(() => '?').join(', ')})`
  );
  const seedAttempt = (attempt: FixtureAttempt): void => {
    const saturationAnchor = attempt.attemptId === '';
    const settledAtMs = saturationAnchor
      ? null
      : attempt.status === 'sent' || attempt.status === 'uncertain'
        ? attempt.preparedAtMs + 2
        : null;
    const responseSubmittedAtMs = version >= 5 ? responseSubmittedAtFor(attempt) : null;
    insertAttempt.run(
      attempt.attemptId,
      attempt.requestId,
      `nonce-${attempt.requestId}`,
      attempt.identityId,
      FIXTURE_SERVER_ID,
      FIXTURE_SOCKET_PATH,
      FIXTURE_SERVER_PID,
      FIXTURE_SERVER_START_TIME,
      FIXTURE_PANE_ID,
      FIXTURE_PANE_PID,
      attempt.waitActive,
      attempt.status,
      attempt.preambleEvery,
      attempt.injectPreamble,
      attempt.cadenceReserved,
      attempt.preparedAtMs,
      attempt.status === 'prepared' ? null : attempt.preparedAtMs + 1,
      settledAtMs,
      attempt.status === 'sent' ? attempt.preparedAtMs + 3 : null,
      ...(version >= 5 ? [responseSubmittedAtMs] : []),
      saturationAnchor ? FIXTURE_SATURATION_AT_MS : attempt.preparedAtMs + 3_600_000,
      ...(version >= 6
        ? [7, saturationAnchor ? Number.MAX_SAFE_INTEGER : FIXTURE_RETENTION_EXPIRES_AT_MS]
        : []),
      ...(version >= 7
        ? [
            attempt.originatorKind,
            attempt.originatorIdentityId,
            attempt.recipientIdentityId,
            attempt.messageText,
            attempt.messageBytes,
            attempt.messageExpiresAtMs,
          ]
        : []),
      ...(version >= 8 ? [attempt.attentionRevision, attempt.attentionRevision === 1 ? 1 : 0] : [])
    );
  };
  database.transaction(() => {
    for (const attempt of attempts) seedAttempt(attempt);
  })();

  if (version >= 5) {
    const insertResponse = database.prepare(
      `INSERT INTO request_responses (
         request_id, attempt_id, server_id, socket_path, server_pid, server_start_time,
         pane_id, pane_pid, body, body_bytes, submitted_at_ms
         ${version >= 6 ? ', response_expires_at_ms' : ''}
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${version >= 6 ? ', ?' : ''})`
    );
    database.transaction(() => {
      for (const attempt of attempts) {
        const body = responseBodyFor(attempt);
        insertResponse.run(
          attempt.requestId,
          attempt.attemptId,
          FIXTURE_SERVER_ID,
          FIXTURE_SOCKET_PATH,
          FIXTURE_SERVER_PID,
          FIXTURE_SERVER_START_TIME,
          FIXTURE_PANE_ID,
          FIXTURE_PANE_PID,
          body,
          Buffer.byteLength(body),
          responseSubmittedAtFor(attempt),
          ...(version >= 6 ? [responseExpiresAtFor(attempt)] : [])
        );
      }
    })();
  }
  if (version >= 8) {
    database
      .prepare(
        `INSERT INTO request_attention_identities
           (identity_id, latest_revision, acknowledged_through)
         VALUES (?, ?, ?), (?, ?, ?)`
      )
      .run(
        FIXTURE_IDENTITY_ID,
        attempts.filter((attempt) => attempt.originatorIdentityId === FIXTURE_IDENTITY_ID).length,
        1,
        FIXTURE_MISSING_IDENTITY_ID,
        attempts.filter((attempt) => attempt.originatorIdentityId === FIXTURE_MISSING_IDENTITY_ID)
          .length,
        0
      );
  }
}

function responseSubmittedAtFor(attempt: FixtureAttempt): number {
  if (attempt.attemptId === '') return FIXTURE_SATURATION_AT_MS;
  if (attempt.requestId === FIXTURE_FINAL_REQUEST_ID) return FIXTURE_FINAL_SUBMITTED_AT_MS;
  return FIXTURE_FINAL_SUBMITTED_AT_MS + Number(attempt.requestId.replace('request-', ''));
}

function responseBodyFor(attempt: FixtureAttempt): string {
  return attempt.requestId === FIXTURE_FINAL_REQUEST_ID
    ? FIXTURE_FINAL_BODY
    : `fixture response ${attempt.requestId}`;
}

function responseExpiresAtFor(attempt: FixtureAttempt): number {
  if (attempt.attemptId === '') return Number.MAX_SAFE_INTEGER;
  if (attempt.requestId === FIXTURE_FINAL_REQUEST_ID) return FIXTURE_FINAL_EXPIRES_AT_MS;
  return FIXTURE_FINAL_EXPIRES_AT_MS + Number(attempt.requestId.replace('request-', ''));
}

/** Create a closed SQLite database at a TypeScript migration prefix. */
export function seedStoragePrefix(file: string, version: number): void {
  const prefix = fixtureVersion(version);
  openPrefix(file, prefix);
  let database: Database.Database | undefined;
  try {
    database = new Database(file);
    database.pragma('foreign_keys = ON');
    seedRows(database, prefix);
  } finally {
    database?.close();
  }
  openPrefix(file, prefix);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function orderedRows(
  database: Database.Database,
  table: string,
  columns: readonly Record<string, unknown>[]
): Record<string, unknown>[] {
  const order = PRIMARY_KEY_ORDER[table] ?? columns.map((column) => String(column.name));
  const orderBy = order.map((column) => quoteIdentifier(column)).join(', ');
  const rows = database
    .prepare(`SELECT * FROM ${quoteIdentifier(table)} ORDER BY ${orderBy}`)
    .all() as Record<string, unknown>[];
  return rows.map((row) => {
    if (table !== '_migrations') return row;
    const { applied_at: _appliedAt, ...migration } = row;
    return migration;
  });
}

/** Read SQLite structure and rows without comparing sqlite_schema SQL text. */
export function storageSnapshot(file: string): StorageSnapshot {
  const database = new Database(file, { readonly: true });
  try {
    const migrations = database
      .prepare('SELECT version, name FROM _migrations ORDER BY version')
      .all() as MigrationSnapshot[];
    const tables: TableSnapshot[] = [];
    const tableNames = database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT GLOB 'sqlite_*' ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    for (const { name: table } of tableNames) {
      const columns = database.pragma(`table_info(${quoteIdentifier(table)})`) as Record<
        string,
        unknown
      >[];
      const indexRows = database.pragma(`index_list(${quoteIdentifier(table)})`) as Array<{
        name: string;
        unique: number;
        origin: string;
        partial: number;
      }>;
      const indexes = indexRows
        .map((index) => ({
          name: index.name,
          unique: index.unique,
          origin: index.origin,
          partial: index.partial,
          columns: database.pragma(`index_xinfo(${quoteIdentifier(index.name)})`) as Record<
            string,
            unknown
          >[],
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
      const foreignKeys = database.pragma(`foreign_key_list(${quoteIdentifier(table)})`) as Record<
        string,
        unknown
      >[];
      tables.push({
        name: table,
        columns,
        indexes,
        foreignKeys,
        rows: orderedRows(database, table, columns),
      });
    }
    return { migrations, tables };
  } finally {
    database.close();
  }
}
