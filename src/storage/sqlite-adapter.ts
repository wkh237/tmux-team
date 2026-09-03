import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { applyMigrations, CURRENT_MIGRATIONS, type MigrationDefinition } from './migrations.js';
import { classifyStorageError, incompatibleSchema, StorageError } from './errors.js';
import type { CheckpointMode, StorageHandle, StorageHealth, StorageLocation } from './ports.js';

export interface StorageOptions {
  readonly migrations?: readonly MigrationDefinition[];
}

function resolveDatabasePath(location: StorageLocation): { directory: string; file: string } {
  if (typeof location === 'string') return { directory: path.dirname(location), file: location };
  return { directory: location.globalDir, file: location.databaseFile };
}

function ensurePrivateDirectory(directory: string): void {
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
  } catch (error) {
    throw new StorageError('permission', `Cannot secure storage directory ${directory}`, {
      cause: error,
    });
  }
}

function secureFile(file: string): void {
  if (process.platform === 'win32' || !fs.existsSync(file)) return;
  try {
    fs.chmodSync(file, 0o600);
    for (const sidecar of [`${file}-wal`, `${file}-shm`]) {
      if (fs.existsSync(sidecar)) fs.chmodSync(sidecar, 0o600);
    }
  } catch (error) {
    throw new StorageError('permission', `Cannot secure storage file ${file}`, { cause: error });
  }
}

function readSchemaVersion(database: Database.Database): number {
  const row = database
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM _migrations')
    .get() as {
    version: number;
  };
  return row.version;
}

function verifyFts5(database: Database.Database): void {
  try {
    database.exec(
      'CREATE VIRTUAL TABLE temp._tmt_fts5_check USING fts5(content); ' +
        'DROP TABLE temp._tmt_fts5_check'
    );
  } catch (error) {
    throw incompatibleSchema('The SQLite runtime does not provide FTS5', error);
  }
}

/** SQLite is an implementation detail; callers receive only lifecycle and health operations. */
function openStorageInternal(
  location: StorageLocation,
  options: StorageOptions = {}
): StorageHandle {
  const resolved = resolveDatabasePath(location);
  ensurePrivateDirectory(resolved.directory);

  let database: Database.Database | undefined;
  try {
    database = new Database(resolved.file);
    database.pragma('foreign_keys = ON');
    database.pragma('journal_mode = WAL');
    database.pragma('busy_timeout = 5000');
    database.pragma('synchronous = NORMAL');
    verifyFts5(database);
    applyMigrations(database, options.migrations ?? CURRENT_MIGRATIONS);
    secureFile(resolved.file);
  } catch (error) {
    try {
      if (database) database.close();
    } catch {
      // Preserve the original structured error.
    }
    throw error instanceof StorageError ? error : classifyStorageError(error, 'Open storage');
  }

  // The constructor and migration sequence above either assign a live handle or throw.
  const openedDatabase = database;
  if (!openedDatabase) throw new StorageError('closed', 'Storage did not open');
  let closed = false;
  const requireOpen = (): Database.Database => {
    if (closed) throw new StorageError('closed', 'Storage is already closed');
    return openedDatabase;
  };

  const checkpoint = (mode: CheckpointMode = 'passive'): void => {
    const current = requireOpen();
    try {
      current.pragma(`wal_checkpoint(${mode.toUpperCase()})`);
      secureFile(resolved.file);
    } catch (error) {
      throw classifyStorageError(error, 'Checkpoint storage');
    }
  };

  return {
    path: resolved.file,
    health(): StorageHealth {
      const current = requireOpen();
      try {
        const foreignKeys = current.pragma('foreign_keys', { simple: true }) as number;
        const journalMode = String(current.pragma('journal_mode', { simple: true }));
        const busyTimeoutMs = current.pragma('busy_timeout', { simple: true }) as number;
        const synchronous = current.pragma('synchronous', { simple: true }) as number;
        if (
          journalMode !== 'wal' ||
          foreignKeys !== 1 ||
          busyTimeoutMs !== 5000 ||
          synchronous !== 1
        ) {
          throw incompatibleSchema('The SQLite connection does not match storage policy');
        }
        return {
          path: resolved.file,
          open: true,
          schemaVersion: readSchemaVersion(current),
          journalMode: 'wal',
          foreignKeys: true,
          busyTimeoutMs,
          synchronous: 'normal',
          fts5: true,
        };
      } catch (error) {
        throw classifyStorageError(error, 'Read storage health');
      }
    },
    checkpoint,
    close(): void {
      if (closed) return;
      let checkpointError: unknown;
      try {
        checkpoint('passive');
      } catch (error) {
        checkpointError = error;
      } finally {
        closed = true;
        try {
          openedDatabase.close();
        } catch (error) {
          checkpointError ??= classifyStorageError(error, 'Close storage');
        }
      }
      if (checkpointError) throw checkpointError;
    },
  };
}

/** Open the user-scoped database with the repository's current migrations. */
export function openStorage(location: StorageLocation): StorageHandle {
  return openStorageInternal(location);
}

/** Test and migration harness entry point; intentionally omitted from the storage package port. */
export function openStorageWithMigrations(
  location: StorageLocation,
  migrations: readonly MigrationDefinition[]
): StorageHandle {
  return openStorageInternal(location, { migrations });
}
