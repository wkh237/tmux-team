import { MAX_ROLE_BYTES, RoleContentError } from './domain/role.js';
import { BoundedFileReadError, readBoundedUtf8File } from './bounded-utf8-file.js';

export type RoleFileErrorCode = 'ROLE_FILE_ERROR';

export class RoleFileError extends Error {
  constructor(
    public readonly code: RoleFileErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'RoleFileError';
  }
}

/** Read one bounded regular file and reject malformed UTF-8 before normalization. */
export function readRoleFile(filePath: string): string {
  try {
    return readBoundedUtf8File(filePath, MAX_ROLE_BYTES);
  } catch (error) {
    if (error instanceof BoundedFileReadError) {
      if (error.kind === 'too_large') {
        throw new RoleContentError(
          'ROLE_INPUT_TOO_LARGE',
          'Role content must not exceed 65536 bytes.'
        );
      }
      if (error.kind === 'invalid') {
        throw new RoleContentError(
          'ROLE_INPUT_INVALID',
          `Role file '${filePath}' is not valid UTF-8.`
        );
      }
      if (error.kind === 'non_regular') {
        throw new RoleFileError(
          'ROLE_FILE_ERROR',
          `Role file '${filePath}' must be a regular file.`
        );
      }
      throw new RoleFileError('ROLE_FILE_ERROR', `Could not read role file '${filePath}'.`, {
        cause: error,
      });
    }
    throw error;
  }
}
