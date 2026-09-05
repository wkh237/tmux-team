import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { CURRENT_MIGRATIONS } from '../storage/migrations.js';
import { openStorageWithMigrations } from '../storage/sqlite-adapter.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const binPath = path.join(repoRoot, 'bin', 'tmux-team');

export interface Sandbox {
  readonly root: string;
  readonly cwd: string;
  readonly home: string;
  readonly xdgConfigHome: string;
  readonly globalDir: string;
  readonly globalConfig: string;
  readonly database: string;
  readonly localConfig: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface CliResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CliRunOptions {
  /** Bytes to write to stdin before closing it; omitted means stdin is ignored. */
  readonly stdin?: string | Uint8Array;
  /** Keep stdin open after writing, for deadline and cleanup scenarios. */
  readonly closeStdin?: boolean;
  /** Combined stdout/stderr bound. Reply JSON can exceed the legacy 1 MiB bound. */
  readonly outputLimitBytes?: number;
  /** Hard process-group deadline, including startup and cleanup. */
  readonly deadlineMs?: number;
}

export type JsonDocument = Record<string, unknown>;

export function createSandbox(): Sandbox {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tmux-team-cli-contract-'));
  try {
    const cwd = path.join(root, 'cwd');
    const home = path.join(root, 'home');
    const xdgConfigHome = path.join(root, 'xdg');
    mkdirSync(cwd);
    mkdirSync(home);

    const globalDir = path.join(xdgConfigHome, 'tmux-team');
    return {
      root,
      cwd,
      home,
      xdgConfigHome,
      globalDir,
      globalConfig: path.join(globalDir, 'config.json'),
      database: path.join(globalDir, 'tmux-team.db'),
      localConfig: path.join(cwd, 'tmux-team.json'),
      env: {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: xdgConfigHome,
        CODEX_HOME: path.join(home, '.codex'),
      },
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function runCli(
  sandbox: Sandbox,
  args: readonly string[],
  options: CliRunOptions = {}
): Promise<CliResult> {
  for (const key of ['TMUX', 'TMUX_PANE', 'TMUX_TEAM_HOME']) delete sandbox.env[key];
  const outputLimitBytes = options.outputLimitBytes ?? 1024 * 1024;
  const deadlineMs = options.deadlineMs ?? 5_000;
  const hasStdin = options.stdin !== undefined;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd: sandbox.cwd,
      env: sandbox.env,
      detached: true,
      stdio: [hasStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // Decode at the stream boundary so a multibyte UTF-8 character split
    // across OS chunks cannot be corrupted by per-buffer toString() calls.
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    if (!stdoutStream || !stderrStream) throw new Error('CLI subprocess output pipes unavailable.');
    stdoutStream.setEncoding('utf8');
    stderrStream.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    const killProcessGroup = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      // The wrapper launches the TypeScript child; kill the process group so a
      // timeout cannot leave that descendant running after the test exits.
      killProcessGroup();
    }, deadlineMs);
    const readOutput =
      (stream: 'stdout' | 'stderr') =>
      (chunk: Buffer | string): void => {
        const text = chunk.toString();
        outputBytes += Buffer.byteLength(text);
        if (outputBytes > outputLimitBytes) {
          outputLimitExceeded = true;
          killProcessGroup();
          return;
        }
        if (stream === 'stdout') stdout += text;
        else stderr += text;
      };
    stdoutStream.on('data', readOutput('stdout'));
    stderrStream.on('data', readOutput('stderr'));
    if (child.stdin) child.stdin.on('error', () => undefined);
    if (hasStdin && child.stdin) {
      if (options.closeStdin === false) child.stdin.write(options.stdin);
      else child.stdin.end(options.stdin);
    }
    child.on('error', (error) => {
      clearTimeout(timer);
      if (outputLimitExceeded) {
        reject(new Error(`CLI subprocess exceeded the ${outputLimitBytes}-byte output bound.`));
      } else reject(error);
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      if (outputLimitExceeded) {
        reject(new Error(`CLI subprocess exceeded the ${outputLimitBytes}-byte output bound.`));
      } else if (timedOut) {
        reject(new Error(`CLI subprocess exceeded the ${deadlineMs} millisecond test bound.`));
      } else {
        resolve({ status, signal, stdout, stderr });
      }
    });
  });
}

export function parseWholeStdout(result: CliResult): JsonDocument {
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe('');
  expect(result.stdout.trim()).not.toBe('');
  // Parse the complete stream. Parsing only the final line would allow human
  // output or a second JSON document to leak into JSON mode unnoticed.
  const document = JSON.parse(result.stdout) as unknown;
  expect(document).toBeTypeOf('object');
  expect(document).not.toBeNull();
  return document as JsonDocument;
}

export function expectError(result: CliResult, code: string, message?: string): JsonDocument {
  const document = parseWholeStdout(result);
  expect(document.error).toMatchObject({ code });
  expect(document.error).toHaveProperty('message', expect.any(String));
  expect((document.error as { message: string }).message.length).toBeGreaterThan(0);
  if (message !== undefined) expect((document.error as { message: string }).message).toBe(message);
  return document;
}

export function expectJsonSuccess(result: CliResult, value: JsonDocument): void {
  expect(result.status).toBe(0);
  expect(parseWholeStdout(result)).toEqual(value);
}

export function fileSnapshot(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else snapshot[path.relative(root, entryPath)] = readFileSync(entryPath, 'utf8');
    }
  };
  visit(root);
  return snapshot;
}

export async function withSandbox<T>(callback: (sandbox: Sandbox) => T | Promise<T>): Promise<T> {
  const sandbox = createSandbox();
  try {
    return await callback(sandbox);
  } finally {
    rmSync(sandbox.root, { recursive: true, force: true });
  }
}

export function initializeDatabase(sandbox: Sandbox): void {
  let storage: ReturnType<typeof openStorageWithMigrations> | undefined;
  try {
    storage = openStorageWithMigrations(sandbox.database, CURRENT_MIGRATIONS);
  } finally {
    storage?.close();
  }
}
