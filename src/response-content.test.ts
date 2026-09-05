import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { PassThrough, Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_RESPONSE_BYTES } from './domain/response.js';
import {
  RESPONSE_INPUT_TIMEOUT_MS,
  ResponseInputError,
  readResponseFile,
  readResponseStdin,
} from './response-content.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-response-input-'));
  directories.push(directory);
  return directory;
}

function expectInputError(action: () => unknown, code: ResponseInputError['code']): void {
  try {
    action();
    expect.fail('expected response input validation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(ResponseInputError);
    expect((error as ResponseInputError).code).toBe(code);
  }
}

describe('durable reply body input', () => {
  it('preserves BOM, NUL, CRLF, Unicode, whitespace, and marker-like text byte-for-byte', () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, 'reply.txt');
    const body = '\ufefffirst\r\n\u0000日本語 😀\r\nRESPONSE-END-fake\n  ';
    fs.writeFileSync(file, Buffer.from(body, 'utf8'));
    expect(readResponseFile(file)).toBe(body);

    const whitespace = path.join(directory, 'whitespace.txt');
    fs.writeFileSync(whitespace, Buffer.from('\ufeff \r\n\t', 'utf8'));
    expect(readResponseFile(whitespace)).toBe('\ufeff \r\n\t');
  });

  it('strictly rejects malformed UTF-8 and always closes the file descriptor', () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, 'invalid.txt');
    fs.writeFileSync(file, Buffer.from([0xc3, 0x28]));
    const open = vi.spyOn(fs, 'openSync');
    const close = vi.spyOn(fs, 'closeSync');
    try {
      expectInputError(() => readResponseFile(file), 'RESPONSE_INPUT_INVALID');
      expect(close).toHaveBeenCalledTimes(1);
      expect(() => fs.fstatSync(open.mock.results[0]!.value as number)).toThrow(/EBADF/);
    } finally {
      open.mockRestore();
      close.mockRestore();
    }
  });

  it('accepts exactly the byte limit and rejects cap-plus-one without partial decoding', () => {
    const directory = temporaryDirectory();
    const exact = path.join(directory, 'exact.txt');
    const oversized = path.join(directory, 'oversized.txt');
    fs.writeFileSync(exact, Buffer.alloc(MAX_RESPONSE_BYTES, 0x61));
    fs.writeFileSync(
      oversized,
      Buffer.concat([Buffer.alloc(MAX_RESPONSE_BYTES, 0x61), Buffer.from('x')])
    );
    expect(Buffer.byteLength(readResponseFile(exact), 'utf8')).toBe(MAX_RESPONSE_BYTES);
    expectInputError(() => readResponseFile(oversized), 'RESPONSE_INPUT_TOO_LARGE');
  });

  it('follows symlinks to regular files and rejects directories, devices, and FIFOs', () => {
    const directory = temporaryDirectory();
    const regular = path.join(directory, 'regular.txt');
    const symlink = path.join(directory, 'link.txt');
    fs.writeFileSync(regular, 'reply');
    fs.symlinkSync(regular, symlink);
    expect(readResponseFile(symlink)).toBe('reply');
    expectInputError(
      () => readResponseFile(path.join(directory, 'missing.txt')),
      'RESPONSE_FILE_ERROR'
    );
    expectInputError(() => readResponseFile(directory), 'RESPONSE_FILE_ERROR');
    expectInputError(() => readResponseFile('/dev/null'), 'RESPONSE_FILE_ERROR');

    const fifo = path.join(directory, 'reply.fifo');
    execFileSync('mkfifo', [fifo]);
    expectInputError(() => readResponseFile(fifo), 'RESPONSE_FILE_ERROR');
    const empty = path.join(directory, 'empty.txt');
    fs.writeFileSync(empty, Buffer.alloc(0));
    expect(readResponseFile(empty)).toBe('');
  });

  it('reads stdin until EOF and removes listeners while pausing the stream', async () => {
    const input = new PassThrough();
    const promise = readResponseStdin(input);
    input.end(Buffer.from('\ufeffline\r\n日本語\u0000', 'utf8'));
    await expect(promise).resolves.toBe('\ufeffline\r\n日本語\u0000');
    expect(input.listenerCount('data')).toBe(0);
    expect(input.listenerCount('end')).toBe(0);
    expect(input.listenerCount('error')).toBe(0);
    expect(input.isPaused()).toBe(true);
  });

  it('accepts the exact stdin byte limit across split multibyte chunks', async () => {
    const input = new PassThrough();
    const promise = readResponseStdin(input);
    input.write(Buffer.alloc(MAX_RESPONSE_BYTES - 4, 0x61));
    input.write(Buffer.from([0xf0]));
    input.write(Buffer.from([0x9f, 0x98]));
    input.end(Buffer.from([0x80]));
    await expect(promise).resolves.toBe('a'.repeat(MAX_RESPONSE_BYTES - 4) + '😀');
    expect(input.listenerCount('data')).toBe(0);
  });

  it('rejects malformed UTF-8, cap-plus-one, and stream errors without accepting partial input', async () => {
    const malformed = new PassThrough();
    const malformedResult = readResponseStdin(malformed);
    malformed.end(Buffer.from([0xc3, 0x28]));
    await expect(malformedResult).rejects.toMatchObject({ code: 'RESPONSE_INPUT_INVALID' });

    const oversized = new PassThrough();
    const oversizedResult = readResponseStdin(oversized);
    oversized.end(Buffer.concat([Buffer.alloc(MAX_RESPONSE_BYTES, 0x61), Buffer.from('x')]));
    await expect(oversizedResult).rejects.toMatchObject({ code: 'RESPONSE_INPUT_TOO_LARGE' });
    expect(oversized.listenerCount('data')).toBe(0);
    expect(oversized.listenerCount('end')).toBe(0);
    expect(oversized.listenerCount('error')).toBe(0);

    const errored = new PassThrough();
    const erroredResult = readResponseStdin(errored);
    errored.destroy(new Error('input broke'));
    await expect(erroredResult).rejects.toMatchObject({ code: 'RESPONSE_INPUT_INVALID' });
    expect(errored.listenerCount('data')).toBe(0);
    expect(errored.listenerCount('close')).toBe(0);
    expect(errored.listenerCount('end')).toBe(0);
    expect(errored.listenerCount('error')).toBe(0);
  });

  it('rejects string/object stream chunks and a close before EOF', async () => {
    const stringInput = new PassThrough();
    stringInput.setEncoding('utf8');
    const stringResult = readResponseStdin(stringInput);
    stringInput.end('text');
    await expect(stringResult).rejects.toMatchObject({ code: 'RESPONSE_INPUT_INVALID' });

    const objectInput = new Readable({ objectMode: true, read() {} });
    const objectResult = readResponseStdin(objectInput);
    objectInput.push({ chunk: 'not bytes' });
    await expect(objectResult).rejects.toMatchObject({ code: 'RESPONSE_INPUT_INVALID' });

    const closed = new PassThrough();
    const closedResult = readResponseStdin(closed);
    closed.destroy();
    await expect(closedResult).rejects.toMatchObject({ code: 'RESPONSE_INPUT_INVALID' });
  });

  it('accepts EOF before the deadline and leaves no timer-visible listeners', async () => {
    const input = new PassThrough();
    const result = readResponseStdin(input, 100);
    setTimeout(() => input.end(Buffer.from('done')), 5);
    await expect(result).resolves.toBe('done');
    expect(input.listenerCount('data')).toBe(0);
    expect(input.listenerCount('end')).toBe(0);
    expect(input.listenerCount('error')).toBe(0);
    expect(input.listenerCount('close')).toBe(0);
  });

  it('returns a typed deadline error and cleans up timer/listeners', async () => {
    vi.useFakeTimers();
    const input = new Readable({ read() {} });
    const now = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(101);
    try {
      const result = readResponseStdin(input, 100);
      expect(vi.getTimerCount()).toBe(1);
      // EOF arrives after the monotonic deadline but before the timer callback;
      // checking the clock in the EOF path prevents accepting late input.
      input.emit('end');
      await expect(result).rejects.toMatchObject({
        code: 'RESPONSE_INPUT_TIMEOUT',
        message: expect.any(String),
      });
      expect(vi.getTimerCount()).toBe(0);
      expect(input.listenerCount('data')).toBe(0);
      expect(input.listenerCount('end')).toBe(0);
      expect(input.listenerCount('error')).toBe(0);
      expect(input.isPaused()).toBe(true);
    } finally {
      now.mockRestore();
      vi.useRealTimers();
    }
    expect(RESPONSE_INPUT_TIMEOUT_MS).toBe(5000);
  });

  it('rejects TTY stdin before installing listeners', async () => {
    const input = new PassThrough();
    Object.defineProperty(input, 'isTTY', { value: true });
    await expect(readResponseStdin(input)).rejects.toMatchObject({
      code: 'RESPONSE_INPUT_INVALID',
    });
    expect(input.listenerCount('data')).toBe(0);
  });
});
