import fs from 'node:fs';
import { TextDecoder } from 'node:util';
import { MAX_ROLE_BYTES, RoleContentError } from './domain/role.js';

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
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch (_error) {
    throw new RoleFileError('ROLE_FILE_ERROR', `Could not read role file '${filePath}'.`, {
      cause: _error,
    });
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new RoleFileError('ROLE_FILE_ERROR', `Role file '${filePath}' must be a regular file.`);
    }
    const buffer = Buffer.alloc(MAX_ROLE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > MAX_ROLE_BYTES) {
      throw new RoleContentError(
        'ROLE_INPUT_TOO_LARGE',
        'Role content must not exceed 65536 bytes.'
      );
    }
    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        buffer.subarray(0, offset)
      );
    } catch {
      throw new RoleContentError(
        'ROLE_INPUT_INVALID',
        `Role file '${filePath}' is not valid UTF-8.`
      );
    }
    return decoded;
  } catch (error) {
    if (error instanceof RoleFileError || error instanceof RoleContentError) throw error;
    throw new RoleFileError('ROLE_FILE_ERROR', `Could not read role file '${filePath}'.`, {
      cause: error,
    });
  } finally {
    fs.closeSync(descriptor);
  }
}
