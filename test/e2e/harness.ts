import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const binPath = path.join(repoRoot, 'bin', 'tmux-team');
const mockAgentPath = path.join(repoRoot, 'test', 'e2e', 'mock-agent.mjs');

export interface CliResult<T = unknown> {
  code: number;
  stdout: string;
  stderr: string;
  json?: T;
}

export interface MockEvent {
  event: string;
  message?: string;
  nonce?: string;
  mode?: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export class E2EFixture {
  readonly root = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-team-e2e-'));
  readonly socketRoot = fs.mkdtempSync(
    path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'te2e-')
  );
  readonly workspace = path.join(this.root, 'workspace');
  readonly globalDir = path.join(this.root, 'global');
  readonly logPath = path.join(this.root, 'mock-agent.jsonl');
  readonly socket = `tmt-e2e-${process.pid}-${Math.random().toString(16).slice(2)}`;
  readonly wrapperDir = path.join(this.root, 'bin');
  readonly tmuxPath: string;
  pane = '';
  socketPath = '';
  private started = false;
  private serverStarted = false;
  private env: NodeJS.ProcessEnv = {};

  constructor() {
    try {
      this.tmuxPath = execFileSync('/bin/sh', ['-lc', 'command -v tmux'], {
        encoding: 'utf8',
      }).trim();
      if (!this.tmuxPath) throw new Error('tmux was not found on PATH.');
    } catch (error) {
      fs.rmSync(this.root, { recursive: true, force: true });
      fs.rmSync(this.socketRoot, { recursive: true, force: true });
      throw new Error(
        `E2E fixture requires tmux: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  start(options: { mode?: 'respond' | 'silent' | 'malformed'; delayMs?: number } = {}): void {
    try {
      fs.mkdirSync(this.workspace, { recursive: true });
      fs.mkdirSync(this.globalDir, { recursive: true });
      fs.mkdirSync(this.wrapperDir, { recursive: true });
      fs.writeFileSync(
        path.join(this.wrapperDir, 'tmux'),
        `#!/bin/sh\nexec ${shellQuote(this.tmuxPath)} -L "$TMT_E2E_SOCKET" "$@"\n`
      );
      fs.chmodSync(path.join(this.wrapperDir, 'tmux'), 0o755);

      this.env = {
        ...process.env,
        PATH: `${this.wrapperDir}${path.delimiter}${process.env.PATH ?? ''}`,
        TMT_E2E_SOCKET: this.socket,
        TMUX_TMPDIR: this.socketRoot,
        TMUX_TEAM_HOME: this.globalDir,
        TMT_MOCK_MODE: options.mode ?? 'respond',
        TMT_MOCK_DELAY_MS: String(options.delayMs ?? 0),
        TMT_MOCK_LOG: this.logPath,
      };
      delete this.env.TMUX;
      delete this.env.TMUX_PANE;

      this.tmux(['-V']);
      this.tmux([
        'new-session',
        '-d',
        '-s',
        'e2e',
        '-x',
        '160',
        '-y',
        '50',
        `${shellQuote(process.execPath)} ${shellQuote(mockAgentPath)}`,
      ]);
      this.serverStarted = true;
      this.socketPath = this.tmux(['display-message', '-p', '#{socket_path}']).trim();
      this.pane = this.tmux(['display-message', '-p', '-t', 'e2e:0.0', '#{pane_id}']).trim();
      if (!this.socketPath || !this.pane) {
        throw new Error('E2E fixture could not determine its socket path and mock-agent pane ID.');
      }
      this.started = true;
    } catch (error) {
      this.stop();
      throw new Error(
        `E2E fixture failed to start its private tmux server: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  runCli<T = Record<string, unknown>>(args: string[]): Promise<CliResult<T>> {
    if (!this.started) throw new Error('E2E fixture must be started before invoking the CLI.');
    const child = spawn(binPath, ['--json', ...args], {
      cwd: this.workspace,
      env: { ...this.env, TMUX_PANE: this.pane },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    return new Promise<CliResult<T>>((resolve) => {
      let settled = false;
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        stderr += `${error.message}\n`;
        resolve({ code: 1, stdout, stderr });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        let json: T | undefined;
        try {
          json = JSON.parse(stdout) as T;
        } catch {
          // The caller receives stdout/stderr for a useful assertion failure.
        }
        resolve({ code: code ?? 1, stdout, stderr, json });
      });
    });
  }

  tmux(args: string[]): string {
    return execFileSync(path.join(this.wrapperDir, 'tmux'), args, {
      env: this.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  events(): MockEvent[] {
    if (!fs.existsSync(this.logPath)) return [];
    return fs
      .readFileSync(this.logPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as MockEvent);
  }

  stop(): void {
    if (this.serverStarted) {
      try {
        this.tmux(['kill-server']);
      } catch {
        // The server may already have exited; cleanup remains best effort.
      }
    }
    this.serverStarted = false;
    this.started = false;
    fs.rmSync(this.root, { recursive: true, force: true });
    fs.rmSync(this.socketRoot, { recursive: true, force: true });
  }

  serverIsRunning(): boolean {
    if (!this.socketPath) return false;
    try {
      execFileSync(this.tmuxPath, ['-S', this.socketPath, 'has-session', '-t', 'e2e'], {
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  }

  sendMockInput(lines: string[]): void {
    for (const line of lines) {
      execFileSync(
        path.join(this.wrapperDir, 'tmux'),
        ['send-keys', '-t', this.pane, '--', line, 'Enter'],
        {
          env: this.env,
          stdio: 'ignore',
        }
      );
    }
  }

  capture(lines = 100): string {
    return this.tmux(['capture-pane', '-p', '-t', this.pane, '-S', `-${lines}`]);
  }

  async waitForCapture(predicate: (output: string) => boolean): Promise<string> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const output = this.capture();
      if (predicate(output)) return output;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for mock-agent pane output.\n${this.capture()}`);
  }
}

export async function withE2EFixture<T>(
  callback: (fixture: E2EFixture) => Promise<T> | T,
  options: { mode?: 'respond' | 'silent' | 'malformed'; delayMs?: number } = {}
): Promise<T> {
  const fixture = new E2EFixture();
  fixture.start(options);
  try {
    return await callback(fixture);
  } finally {
    fixture.stop();
  }
}
