import type Database from 'better-sqlite3';
import {
  EXCHANGE_METADATA_SETTLEMENT_FLOOR_MS,
  EXCHANGE_RESPONSE_ACCEPTANCE_WINDOW_MS,
  LEGACY_EXCHANGE_RETENTION_DAYS,
  RETENTION_DAY_MS,
} from '../domain/exchange-retention.js';
import { classifyStorageError, incompatibleSchema, StorageError } from './errors.js';

type SqliteDatabase = Database.Database;

function saturatingAddMilliseconds(value: number, delta: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || !Number.isSafeInteger(delta) || delta < 0) {
    throw new Error(`${label} is outside the supported range.`);
  }
  return value > Number.MAX_SAFE_INTEGER - delta ? Number.MAX_SAFE_INTEGER : value + delta;
}

export interface MigrationDefinition {
  readonly version: number;
  readonly name: string;
  readonly up: (database: SqliteDatabase) => void;
}

/** Domain tables are appended by their owning tickets, in migration order. */
export const CURRENT_MIGRATIONS: readonly MigrationDefinition[] = [
  {
    version: 1,
    name: 'create durable identities and transient tmux bindings',
    up: (database) =>
      database.exec(`
        CREATE TABLE identities (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          canonical_name TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE bindings (
          id TEXT PRIMARY KEY,
          identity_id TEXT NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
          transport TEXT NOT NULL CHECK (transport = 'tmux'),
          pane_id TEXT NOT NULL,
          server_id TEXT NOT NULL,
          socket_path TEXT NOT NULL,
          server_pid INTEGER NOT NULL,
          server_start_time TEXT NOT NULL,
          pane_pid INTEGER NOT NULL,
          bound_at TEXT NOT NULL,
          last_verified_at TEXT NOT NULL,
          UNIQUE(identity_id),
          UNIQUE(transport, server_id, pane_id)
        );
        CREATE INDEX bindings_endpoint ON bindings(transport, server_id, pane_id);
      `),
  },
  {
    version: 2,
    name: 'create optional identity role profiles',
    up: (database) =>
      database.exec(`
        CREATE TABLE role_profiles (
          identity_id TEXT NOT NULL PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
          content TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `),
  },
  {
    version: 3,
    name: 'create durable identity preambles',
    up: (database) =>
      database.exec(`
        CREATE TABLE identity_preambles (
          identity_id TEXT NOT NULL PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
          content TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `),
  },
  {
    version: 4,
    name: 'create request attempts and preamble cadence counters',
    up: (database) =>
      database.exec(`
        CREATE TABLE preamble_counters (
          identity_id TEXT PRIMARY KEY REFERENCES identities(id) ON DELETE CASCADE,
          reserved_count INTEGER NOT NULL CHECK (reserved_count >= 0),
          updated_at_ms INTEGER NOT NULL
        );
        CREATE TABLE request_attempts (
          attempt_id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL UNIQUE,
          nonce TEXT,
          identity_id TEXT REFERENCES identities(id) ON DELETE SET NULL,
          server_id TEXT NOT NULL,
          socket_path TEXT NOT NULL,
          server_pid INTEGER NOT NULL CHECK (server_pid > 0),
          server_start_time TEXT NOT NULL,
          pane_id TEXT NOT NULL,
          pane_pid INTEGER NOT NULL CHECK (pane_pid > 0),
          wait_active INTEGER NOT NULL CHECK (wait_active IN (0, 1)),
          status TEXT NOT NULL CHECK (
            status IN ('prepared', 'sending', 'sent', 'uncertain', 'definitely_failed')
          ),
          preamble_every INTEGER CHECK (preamble_every IS NULL OR preamble_every > 0),
          inject_preamble INTEGER NOT NULL CHECK (inject_preamble IN (0, 1)),
          cadence_reserved INTEGER NOT NULL CHECK (cadence_reserved IN (0, 1)),
          prepared_at_ms INTEGER NOT NULL,
          sending_at_ms INTEGER,
          settled_at_ms INTEGER,
          wait_released_at_ms INTEGER,
          expires_at_ms INTEGER NOT NULL
        );
        CREATE INDEX request_attempts_endpoint_active
          ON request_attempts (
            server_id, socket_path, server_pid, server_start_time, pane_id, pane_pid,
            wait_active, status, prepared_at_ms
          );
        CREATE INDEX request_attempts_retention
          ON request_attempts (wait_active, status, settled_at_ms);
        CREATE INDEX request_attempts_expiry
          ON request_attempts (expires_at_ms, status);
      `),
  },
  {
    version: 5,
    name: 'create immutable request responses',
    up: (database) =>
      database.exec(`
        ALTER TABLE request_attempts
          ADD COLUMN response_submitted_at_ms INTEGER;
        CREATE TABLE request_responses (
          request_id TEXT PRIMARY KEY,
          attempt_id TEXT NOT NULL,
          server_id TEXT NOT NULL,
          socket_path TEXT NOT NULL,
          server_pid INTEGER NOT NULL CHECK (server_pid > 0),
          server_start_time TEXT NOT NULL,
          pane_id TEXT NOT NULL,
          pane_pid INTEGER NOT NULL CHECK (pane_pid > 0),
          body TEXT NOT NULL,
          body_bytes INTEGER NOT NULL CHECK (body_bytes >= 0),
          submitted_at_ms INTEGER NOT NULL CHECK (submitted_at_ms > 0)
        );
        CREATE INDEX request_responses_retention
          ON request_responses (submitted_at_ms);
      `),
  },
  {
    version: 6,
    name: 'freeze exchange retention and response expiry horizons',
    up: (database) => {
      database.exec(`
        ALTER TABLE request_attempts
          ADD COLUMN retention_days INTEGER NOT NULL DEFAULT ${LEGACY_EXCHANGE_RETENTION_DAYS};
        ALTER TABLE request_attempts
          ADD COLUMN retention_expires_at_ms INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE request_responses
          ADD COLUMN response_expires_at_ms INTEGER NOT NULL DEFAULT 0;
      `);

      const selectAttempts = database.prepare(
        `SELECT attempt_id, prepared_at_ms, expires_at_ms, settled_at_ms
         FROM request_attempts
         WHERE attempt_id > ?
         ORDER BY attempt_id
         LIMIT 100`
      );
      const selectFirstAttempts = database.prepare(
        `SELECT attempt_id, prepared_at_ms, expires_at_ms, settled_at_ms
         FROM request_attempts ORDER BY attempt_id LIMIT 100`
      );
      const updateAttempt = database.prepare(
        'UPDATE request_attempts SET retention_expires_at_ms = ? WHERE attempt_id = ?'
      );
      let previousAttemptId: string | undefined;
      while (true) {
        const attempts = (
          previousAttemptId === undefined
            ? selectFirstAttempts.all()
            : selectAttempts.all(previousAttemptId)
        ) as Array<{
          attempt_id: string;
          prepared_at_ms: number;
          expires_at_ms: number;
          settled_at_ms: number | null;
        }>;
        if (attempts.length === 0) break;
        for (const attempt of attempts) {
          const frozenRetention = saturatingAddMilliseconds(
            attempt.prepared_at_ms,
            LEGACY_EXCHANGE_RETENTION_DAYS * RETENTION_DAY_MS,
            `Attempt '${attempt.attempt_id}' retention expiry`
          );
          const responseAcceptance = saturatingAddMilliseconds(
            attempt.prepared_at_ms,
            EXCHANGE_RESPONSE_ACCEPTANCE_WINDOW_MS,
            `Attempt '${attempt.attempt_id}' response acceptance deadline`
          );
          const settlementFloor = saturatingAddMilliseconds(
            attempt.expires_at_ms,
            EXCHANGE_METADATA_SETTLEMENT_FLOOR_MS,
            `Attempt '${attempt.attempt_id}' settlement retention floor`
          );
          const settledFloor =
            attempt.settled_at_ms === null
              ? 0
              : saturatingAddMilliseconds(
                  attempt.settled_at_ms,
                  EXCHANGE_METADATA_SETTLEMENT_FLOOR_MS,
                  `Attempt '${attempt.attempt_id}' settled retention floor`
                );
          updateAttempt.run(
            Math.max(frozenRetention, responseAcceptance, settlementFloor, settledFloor),
            attempt.attempt_id
          );
          previousAttemptId = attempt.attempt_id;
        }
      }

      const selectResponses = database.prepare(
        `SELECT request_id, submitted_at_ms
         FROM request_responses
         WHERE request_id > ?
         ORDER BY request_id
         LIMIT 100`
      );
      const selectFirstResponses = database.prepare(
        `SELECT request_id, submitted_at_ms
         FROM request_responses ORDER BY request_id LIMIT 100`
      );
      const updateResponse = database.prepare(
        'UPDATE request_responses SET response_expires_at_ms = ? WHERE request_id = ?'
      );
      let previousRequestId: string | undefined;
      while (true) {
        const responses = (
          previousRequestId === undefined
            ? selectFirstResponses.all()
            : selectResponses.all(previousRequestId)
        ) as Array<{
          request_id: string;
          submitted_at_ms: number;
        }>;
        if (responses.length === 0) break;
        for (const response of responses) {
          updateResponse.run(
            saturatingAddMilliseconds(
              response.submitted_at_ms,
              LEGACY_EXCHANGE_RETENTION_DAYS * RETENTION_DAY_MS,
              `Response '${response.request_id}' retention expiry`
            ),
            response.request_id
          );
          previousRequestId = response.request_id;
        }
      }
      database.exec(`
        UPDATE request_attempts
        SET retention_expires_at_ms = MAX(
          retention_expires_at_ms,
          COALESCE(
            (SELECT response_expires_at_ms
             FROM request_responses
             WHERE request_responses.request_id = request_attempts.request_id
               AND request_responses.attempt_id = request_attempts.attempt_id),
            retention_expires_at_ms
          )
        )
      `);

      database.exec(`
        CREATE INDEX request_attempts_retention_horizon
          ON request_attempts (retention_expires_at_ms, attempt_id);
        CREATE INDEX request_attempts_cleanup_expiry
          ON request_attempts (expires_at_ms, attempt_id)
          WHERE wait_active = 1 OR status IN ('prepared', 'sending');
        CREATE INDEX request_responses_expiry
          ON request_responses (response_expires_at_ms, request_id);
        CREATE INDEX request_responses_attempt
          ON request_responses (attempt_id, response_expires_at_ms);
      `);
    },
  },
  {
    version: 7,
    name: 'retain request provenance and bounded original prompts',
    up: (database) =>
      database.exec(`
        ALTER TABLE request_attempts
          ADD COLUMN originator_kind TEXT NOT NULL DEFAULT 'unknown'
            CHECK (originator_kind IN ('unknown', 'explicit', 'verified'));
        ALTER TABLE request_attempts
          ADD COLUMN originator_identity_id TEXT
            CHECK (
              (originator_kind = 'unknown' AND originator_identity_id IS NULL) OR
              (originator_kind IN ('explicit', 'verified') AND originator_identity_id IS NOT NULL)
            );
        ALTER TABLE request_attempts
          ADD COLUMN recipient_identity_id TEXT;
        ALTER TABLE request_attempts
          ADD COLUMN message_text TEXT;
        ALTER TABLE request_attempts
          ADD COLUMN message_bytes INTEGER
            CHECK (message_bytes IS NULL OR message_bytes >= 0);
        ALTER TABLE request_attempts
          ADD COLUMN message_expires_at_ms INTEGER;
        CREATE INDEX request_attempts_prompt_expiry
          ON request_attempts (message_expires_at_ms, attempt_id)
          WHERE message_text IS NOT NULL;
      `),
  },
  {
    version: 8,
    name: 'add identity-scoped exchange attention revisions',
    up: (database) =>
      database.exec(`
        ALTER TABLE request_attempts
          ADD COLUMN attention_revision INTEGER NOT NULL DEFAULT 0
            CHECK (
              typeof(attention_revision) = 'integer' AND
              attention_revision >= 0 AND attention_revision <= 9007199254740991
            );
        ALTER TABLE request_attempts
          ADD COLUMN attention_acknowledged_revision INTEGER NOT NULL DEFAULT 0
            CHECK (
              typeof(attention_acknowledged_revision) = 'integer' AND
              attention_acknowledged_revision >= 0 AND
              attention_acknowledged_revision <= 9007199254740991
            );
        CREATE TABLE request_attention_identities (
          identity_id TEXT PRIMARY KEY,
          latest_revision INTEGER NOT NULL CHECK (
            typeof(latest_revision) = 'integer' AND
            latest_revision >= 0 AND latest_revision <= 9007199254740991
          ),
          acknowledged_through INTEGER NOT NULL CHECK (
            typeof(acknowledged_through) = 'integer' AND
            acknowledged_through <= latest_revision AND
            acknowledged_through >= 0 AND acknowledged_through <= 9007199254740991
          )
        );
        WITH ranked AS (
          SELECT attempt_id,
                 ROW_NUMBER() OVER (
                   PARTITION BY originator_identity_id
                   ORDER BY prepared_at_ms, request_id
                 ) AS revision
          FROM request_attempts
          WHERE originator_identity_id IS NOT NULL
        )
        UPDATE request_attempts
        SET attention_revision = (
          SELECT revision FROM ranked WHERE ranked.attempt_id = request_attempts.attempt_id
        )
        WHERE attempt_id IN (SELECT attempt_id FROM ranked);
        INSERT INTO request_attention_identities (identity_id, latest_revision, acknowledged_through)
          SELECT originator_identity_id, MAX(attention_revision), 0
          FROM request_attempts
          WHERE originator_identity_id IS NOT NULL
          GROUP BY originator_identity_id;
        CREATE INDEX request_attempts_attention
          ON request_attempts (originator_identity_id, attention_revision, request_id);
      `),
  },
];

const CREATE_MIGRATIONS = `
  CREATE TABLE IF NOT EXISTS _migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )
`;

function validateMigrationsTable(database: SqliteDatabase): void {
  const columns = database.pragma('table_info(_migrations)') as Array<{
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }>;
  const expected = [
    { name: 'version', type: 'INTEGER', notnull: 0, pk: 1 },
    { name: 'name', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'applied_at', type: 'TEXT', notnull: 1, pk: 0 },
  ];
  if (
    columns.length !== expected.length ||
    columns.some((column, index) => {
      const wanted = expected[index];
      return (
        !wanted ||
        column.name !== wanted.name ||
        column.type.toUpperCase() !== wanted.type ||
        column.notnull !== wanted.notnull ||
        column.pk !== wanted.pk
      );
    })
  ) {
    throw incompatibleSchema('The _migrations table does not match the supported schema');
  }
}

function validateDefinitions(migrations: readonly MigrationDefinition[]): void {
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index];
    if (!migration || migration.version !== index + 1 || !migration.name || !migration.up) {
      throw incompatibleSchema('Migration definitions must be contiguous, forward-only, and named');
    }
  }
}

function validateHistory(
  history: Array<{ version: number; name: string }>,
  migrations: readonly MigrationDefinition[]
): number {
  let expected = 1;
  for (const row of history) {
    if (!Number.isSafeInteger(row.version) || row.version !== expected) {
      throw incompatibleSchema(`Migration history is not contiguous at version ${row.version}`);
    }
    const definition = migrations[row.version - 1];
    if (!definition) {
      throw incompatibleSchema(`Database requires unsupported migration version ${row.version}`);
    }
    if (definition.name !== row.name) {
      throw incompatibleSchema(
        `Migration ${row.version} has changed from ${row.name} to ${definition.name}`
      );
    }
    expected += 1;
  }
  return expected - 1;
}

export function applyMigrations(
  database: SqliteDatabase,
  migrations: readonly MigrationDefinition[] = CURRENT_MIGRATIONS
): number {
  validateDefinitions(migrations);

  try {
    database
      .transaction(() => {
        database.exec(CREATE_MIGRATIONS);
        validateMigrationsTable(database);
      })
      .immediate();

    const history = database
      .prepare('SELECT version, name FROM _migrations ORDER BY version')
      .all() as Array<{ version: number; name: string }>;
    const currentVersion = validateHistory(history, migrations);
    const insert = database.prepare(
      'INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)'
    );

    for (let index = currentVersion; index < migrations.length; index += 1) {
      const migration = migrations[index];
      const applyOne = database.transaction(() => {
        try {
          // Recheck while holding the write transaction. Another process may
          // have applied this migration after the initial history read.
          const latest = database
            .prepare('SELECT version, name FROM _migrations ORDER BY version')
            .all() as Array<{ version: number; name: string }>;
          if (validateHistory(latest, migrations) >= migration.version) return;
          migration.up(database);
          insert.run(migration.version, migration.name, new Date().toISOString());
        } catch (error) {
          const classified = classifyStorageError(error, `Migration ${migration.version}`);
          throw new StorageError('migration', `Migration ${migration.version} failed`, {
            cause: classified,
            migrationVersion: migration.version,
            retryable: classified.retryable,
          });
        }
      });
      applyOne.immediate();
    }
    return migrations.length;
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw classifyStorageError(error, 'Database migration');
  }
}
