import { describe, expect, it } from 'vitest';
import { classifyStorageError, incompatibleSchema, StorageError } from './errors.js';

describe('storage error contract', () => {
  it('marks busy and locked failures retryable', () => {
    const cause = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    const error = classifyStorageError(cause, 'Write');

    expect(error).toMatchObject({ code: 'busy', retryable: true, cause });
  });

  it('maps open access failures separately from corruption', () => {
    const cause = Object.assign(new Error('cannot open'), { code: 'SQLITE_CANTOPEN' });
    const error = classifyStorageError(cause, 'Open storage');

    expect(error).toMatchObject({ code: 'permission', retryable: false, cause });
  });

  it('retains migration version and cause for migration failures', () => {
    const cause = new Error('constraint failed');
    const error = new StorageError('migration', 'Migration failed', {
      cause,
      migrationVersion: 4,
    });

    expect(error).toMatchObject({ code: 'migration', migrationVersion: 4, cause });
  });

  it('provides a structured incompatible schema error', () => {
    const cause = new Error('future schema');
    expect(incompatibleSchema('Unsupported schema', cause)).toMatchObject({
      code: 'incompatible-schema',
      cause,
      retryable: false,
    });
  });

  it('does not mislabel an unknown native failure as a migration error', () => {
    const cause = new Error('unexpected native failure');
    expect(classifyStorageError(cause, 'Open storage')).toMatchObject({
      code: 'unknown',
      cause,
      retryable: false,
    });
  });
});
