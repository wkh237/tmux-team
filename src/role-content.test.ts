import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { MAX_ROLE_BYTES, RoleContentError, normalizeRoleContent } from './domain/role.js';
import { readRoleFile, RoleFileError } from './role-content.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-role-input-'));
  directories.push(directory);
  return directory;
}

function expectContentError(action: () => unknown, code: RoleContentError['code']): void {
  try {
    action();
    expect.fail('expected role content validation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(RoleContentError);
    expect((error as RoleContentError).code).toBe(code);
  }
}

// Non-ASCII fixture text exercises UTF-8 byte counts and valid surrogate pairs.
describe('role content input', () => {
  it('normalizes CRLF/CR, preserves allowed whitespace, and strips exactly one initial BOM', () => {
    expect(normalizeRoleContent('\ufeff\ufeff\t one\r\ntwo\r\n')).toBe('\ufeff\t one\ntwo\n');
    expect(normalizeRoleContent('role\rnext\n')).toBe('role\nnext\n');
  });

  it('rejects whitespace-only content, C0/DEL controls, and lone surrogates', () => {
    expectContentError(() => normalizeRoleContent(' \n\t\r'), 'ROLE_INPUT_INVALID');
    for (const value of ['bad\u0000', 'bad\u0001', 'bad\u007f']) {
      expectContentError(() => normalizeRoleContent(value), 'ROLE_INPUT_INVALID');
    }
    for (const value of ['bad\ud800', 'bad\udc00', '\ud800\udc00\ud800']) {
      expectContentError(() => normalizeRoleContent(value), 'ROLE_INPUT_INVALID');
    }
    expect(normalizeRoleContent('valid 😀 pair')).toBe('valid 😀 pair');
  });

  it('enforces the raw UTF-8 byte limit before normalization', () => {
    const exact = 'a'.repeat(MAX_ROLE_BYTES);
    expect(normalizeRoleContent(exact)).toBe(exact);
    expectContentError(() => normalizeRoleContent(`${exact}a`), 'ROLE_INPUT_TOO_LARGE');

    const multibyte = '😀'.repeat(Math.floor(MAX_ROLE_BYTES / 4));
    expect(Buffer.byteLength(multibyte, 'utf8')).toBe(MAX_ROLE_BYTES);
    expect(normalizeRoleContent(multibyte)).toBe(multibyte);
    expectContentError(() => normalizeRoleContent(`${multibyte}😀`), 'ROLE_INPUT_TOO_LARGE');

    // Removing CRs would make this fit, but raw input is what is bounded.
    const rawOversized = `${'a'.repeat(MAX_ROLE_BYTES - 1)}\r\n`;
    expect(Buffer.byteLength(rawOversized, 'utf8')).toBe(MAX_ROLE_BYTES + 1);
    expect(Buffer.byteLength(rawOversized.replace('\r\n', '\n'), 'utf8')).toBe(MAX_ROLE_BYTES);
    expectContentError(() => normalizeRoleContent(rawOversized), 'ROLE_INPUT_TOO_LARGE');
  });

  it('strictly decodes UTF-8 and leaves normalization to the service', () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, 'role.txt');
    fs.writeFileSync(file, Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x41, 0x0d]));
    expect(readRoleFile(file)).toBe('\ufeff\ufeffA\r');
    fs.writeFileSync(file, Buffer.from([0xc3, 0x28]));
    expectContentError(() => readRoleFile(file), 'ROLE_INPUT_INVALID');
  });

  it('keeps inline and file normalization identical, including a double BOM', () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, 'role.txt');
    const input = '\ufeff\ufeff# Profile\r\n\tline\r\n';
    fs.writeFileSync(file, Buffer.from(input, 'utf8'));
    expect(normalizeRoleContent(readRoleFile(file))).toBe(normalizeRoleContent(input));
  });

  it('bounds regular-file reads at exactly 65536 raw bytes', () => {
    const directory = temporaryDirectory();
    const exact = path.join(directory, 'exact.txt');
    const oversized = path.join(directory, 'oversized.txt');
    fs.writeFileSync(exact, Buffer.alloc(MAX_ROLE_BYTES, 0x61));
    fs.writeFileSync(oversized, Buffer.alloc(MAX_ROLE_BYTES + 1, 0x61));
    expect(readRoleFile(exact)).toHaveLength(MAX_ROLE_BYTES);
    expectContentError(() => readRoleFile(oversized), 'ROLE_INPUT_TOO_LARGE');

    const multibyte = path.join(directory, 'multibyte.txt');
    const emoji = Buffer.from('😀', 'utf8');
    fs.writeFileSync(multibyte, Buffer.concat([Buffer.alloc(MAX_ROLE_BYTES - 4, 0x61), emoji]));
    expect(Buffer.byteLength(readRoleFile(multibyte), 'utf8')).toBe(MAX_ROLE_BYTES);
  });

  it('allows symlinked regular files and rejects directories, devices, and FIFOs promptly', () => {
    const directory = temporaryDirectory();
    const regular = path.join(directory, 'regular.txt');
    const symlink = path.join(directory, 'link.txt');
    fs.writeFileSync(regular, 'role');
    fs.symlinkSync(regular, symlink);
    expect(readRoleFile(symlink)).toBe('role');
    expect(() => readRoleFile(directory)).toThrow(RoleFileError);
    expect(() => readRoleFile('/dev/null')).toThrow(RoleFileError);

    const fifo = path.join(directory, 'role.fifo');
    execFileSync('mkfifo', [fifo]);
    // A blocking-open regression must fail within a bound, not hang Vitest itself.
    const moduleUrl = pathToFileURL(path.resolve('src/role-content.ts')).href;
    const script = `import { readRoleFile } from ${JSON.stringify(moduleUrl)};
      try { readRoleFile(process.argv[1]); process.exit(2); }
      catch (error) { if (error.code !== 'ROLE_FILE_ERROR') throw error; }`;
    expect(() =>
      execFileSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script, fifo],
        { timeout: 3000, stdio: 'pipe' }
      )
    ).not.toThrow();
  });

  it('closes the descriptor when decode fails', () => {
    const directory = temporaryDirectory();
    const file = path.join(directory, 'invalid.txt');
    fs.writeFileSync(file, Buffer.from([0xc3, 0x28]));
    const close = vi.spyOn(fs, 'closeSync');
    try {
      expectContentError(() => readRoleFile(file), 'ROLE_INPUT_INVALID');
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
  });
});
