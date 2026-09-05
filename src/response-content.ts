import { TextDecoder } from 'node:util';
import type { Readable } from 'node:stream';
import { BoundedFileReadError, readBoundedUtf8File } from './bounded-utf8-file.js';
import { MAX_RESPONSE_BYTES } from './domain/response.js';

export const RESPONSE_INPUT_TIMEOUT_MS = 5000;

export type ResponseInputErrorCode =
  | 'RESPONSE_INPUT_INVALID'
  | 'RESPONSE_INPUT_TOO_LARGE'
  | 'RESPONSE_INPUT_TIMEOUT'
  | 'RESPONSE_FILE_ERROR';

export class ResponseInputError extends Error {
  constructor(
    public readonly code: ResponseInputErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'ResponseInputError';
  }
}

function decodeBody(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new ResponseInputError('RESPONSE_INPUT_INVALID', 'Response input is not valid UTF-8.', {
      cause: error,
    });
  }
}

/** Read a complete bounded response from an explicitly selected regular file. */
export function readResponseFile(filePath: string): string {
  try {
    return readBoundedUtf8File(filePath, MAX_RESPONSE_BYTES);
  } catch (error) {
    if (error instanceof BoundedFileReadError) {
      if (error.kind === 'too_large') {
        throw new ResponseInputError(
          'RESPONSE_INPUT_TOO_LARGE',
          `Response body must not exceed ${MAX_RESPONSE_BYTES} UTF-8 bytes.`,
          { cause: error }
        );
      }
      if (error.kind === 'invalid') {
        throw new ResponseInputError(
          'RESPONSE_INPUT_INVALID',
          'Response input is not valid UTF-8.',
          { cause: error }
        );
      }
      throw new ResponseInputError('RESPONSE_FILE_ERROR', 'Could not read response input file.', {
        cause: error,
      });
    }
    throw error;
  }
}

function pause(stream: Readable): void {
  try {
    stream.pause();
  } catch {
    // Cleanup must not replace the settled input result.
  }
}

/** Read one complete EOF-delimited response from stdin with a hard deadline. */
export function readResponseStdin(
  input: Readable & { readonly isTTY?: boolean } = process.stdin,
  timeoutMs = RESPONSE_INPUT_TIMEOUT_MS
): Promise<string> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(
      new ResponseInputError('RESPONSE_INPUT_INVALID', 'Response input timeout is invalid.')
    );
  }
  if (input.isTTY) {
    return Promise.reject(
      new ResponseInputError('RESPONSE_INPUT_INVALID', 'Response input cannot be a TTY.')
    );
  }

  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const deadline = performance.now() + timeoutMs;
    const expired = (): boolean => performance.now() >= deadline;

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('error', onError);
      input.removeListener('close', onClose);
      pause(input);
    };
    const settle = (result: { value: string } | { error: Error }): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if ('error' in result) reject(result.error);
      else resolve(result.value);
    };
    const onData = (chunk: unknown): void => {
      if (expired()) {
        settle({
          error: new ResponseInputError(
            'RESPONSE_INPUT_TIMEOUT',
            'Timed out while reading response input.'
          ),
        });
        return;
      }
      if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
        settle({
          error: new ResponseInputError(
            'RESPONSE_INPUT_INVALID',
            'Response input must be binary data.'
          ),
        });
        return;
      }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        settle({
          error: new ResponseInputError(
            'RESPONSE_INPUT_TOO_LARGE',
            `Response body must not exceed ${MAX_RESPONSE_BYTES} UTF-8 bytes.`
          ),
        });
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = (): void => {
      if (expired()) {
        settle({
          error: new ResponseInputError(
            'RESPONSE_INPUT_TIMEOUT',
            'Timed out while reading response input.'
          ),
        });
        return;
      }
      try {
        settle({ value: decodeBody(Buffer.concat(chunks, totalBytes)) });
      } catch (error) {
        settle({
          error:
            error instanceof Error
              ? error
              : new ResponseInputError('RESPONSE_INPUT_INVALID', 'Response input is invalid.'),
        });
      }
    };
    const onError = (error: Error): void => {
      settle({
        error: new ResponseInputError('RESPONSE_INPUT_INVALID', 'Could not read response input.', {
          cause: error,
        }),
      });
    };
    const onClose = (): void => {
      settle({
        error: new ResponseInputError(
          'RESPONSE_INPUT_INVALID',
          'Response input closed before EOF.'
        ),
      });
    };

    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onError);
    input.once('close', onClose);
    timer = setTimeout(() => {
      settle({
        error: new ResponseInputError(
          'RESPONSE_INPUT_TIMEOUT',
          'Timed out while reading response input.'
        ),
      });
    }, timeoutMs);
    input.resume();
  });
}
