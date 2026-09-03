export type StorageErrorCode =
  | 'busy'
  | 'corrupt'
  | 'permission'
  | 'incompatible-schema'
  | 'migration'
  | 'unknown'
  | 'closed';

export interface StorageErrorOptions {
  cause?: unknown;
  migrationVersion?: number;
  retryable?: boolean;
}

/** A stable error boundary for storage callers. The native driver's error is retained as cause. */
export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly migrationVersion?: number;
  readonly retryable: boolean;

  constructor(code: StorageErrorCode, message: string, options: StorageErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'StorageError';
    this.code = code;
    this.migrationVersion = options.migrationVersion;
    this.retryable = options.retryable ?? code === 'busy';
  }
}

function nativeCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

/** Convert better-sqlite3 and filesystem failures into the storage contract. */
export function classifyStorageError(error: unknown, operation: string): StorageError {
  if (error instanceof StorageError) return error;

  const code = nativeCode(error);
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
    return new StorageError('busy', `${operation} is temporarily locked`, {
      cause: error,
      retryable: true,
    });
  }
  if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB') {
    return new StorageError('corrupt', `${operation} found a corrupt SQLite database`, {
      cause: error,
    });
  }
  if (
    code === 'SQLITE_CANTOPEN' ||
    code === 'SQLITE_READONLY' ||
    code === 'SQLITE_PERM' ||
    code === 'EACCES' ||
    code === 'EPERM'
  ) {
    return new StorageError('permission', `${operation} cannot access the database`, {
      cause: error,
    });
  }
  return new StorageError('unknown', `${operation} failed`, { cause: error });
}

export function incompatibleSchema(message: string, cause?: unknown): StorageError {
  return new StorageError('incompatible-schema', message, { cause });
}
