import fs from 'node:fs';
import { TextDecoder } from 'node:util';

export type BoundedFileReadErrorKind = 'file' | 'non_regular' | 'too_large' | 'invalid';

export class BoundedFileReadError extends Error {
  constructor(
    public readonly kind: BoundedFileReadErrorKind,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'BoundedFileReadError';
  }
}

/** Read a regular file with a byte bound and strict, non-normalizing UTF-8 decoding. */
export function readBoundedUtf8File(filePath: string, maxBytes: number): string {
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch (error) {
    throw new BoundedFileReadError('file', 'Could not read bounded content file.', {
      cause: error,
    });
  }
  let failure: BoundedFileReadError | undefined;
  let decoded: string | undefined;
  let closeError: unknown;
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new BoundedFileReadError(
        'non_regular',
        'Bounded content input must be a regular file.'
      );
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = fs.readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > maxBytes) {
      throw new BoundedFileReadError('too_large', 'Bounded content input is too large.');
    }
    try {
      decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        buffer.subarray(0, offset)
      );
    } catch (error) {
      throw new BoundedFileReadError('invalid', 'Bounded content input is not valid UTF-8.', {
        cause: error,
      });
    }
  } catch (error) {
    failure =
      error instanceof BoundedFileReadError
        ? error
        : new BoundedFileReadError('file', 'Could not read bounded content file.', {
            cause: error,
          });
  } finally {
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      closeError = error;
    }
  }
  if (failure) throw failure;
  if (closeError) {
    throw new BoundedFileReadError('file', 'Could not close bounded content file.', {
      cause: closeError,
    });
  }
  return decoded!;
}
