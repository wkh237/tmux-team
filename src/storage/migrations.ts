import type Database from 'better-sqlite3';
import { classifyStorageError, incompatibleSchema, StorageError } from './errors.js';

type SqliteDatabase = Database.Database;

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
