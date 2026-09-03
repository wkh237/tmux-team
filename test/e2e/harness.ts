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
  event: 'ready' | 'request' | 'response' | 'silent' | 'malformed' | 'stopped';
  message?: string;
  nonce?: string;
  mode?: string;
  pid?: number;
}

export interface MockPane {
  pane: string;
  pid: number;
  workspace: string;
}

export interface CliRunOptions {
  cwd?: string;
  pane?: string;
  /** Remove pane context and fail visibly if the CLI attempts to invoke tmux. */
  withoutTmux?: boolean;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export class E2EFixture {
  readonly root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-team-e2e-')));
  readonly socketRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'te2e-'))
  );
  readonly workspace = path.join(this.root, 'workspace');
  readonly globalDir = path.join(this.root, 'global');
  readonly logPath = path.join(this.root, 'mock-agent.jsonl');
  readonly forbiddenTmuxLogPath = path.join(this.root, 'forbidden-tmux.log');
  readonly socket = `tmt-e2e-${process.pid}-${Math.random().toString(16).slice(2)}`;
  readonly wrapperDir = path.join(this.root, 'bin');
  readonly tmuxPath: string;
  pane = '';
  panePid = 0;
  serverPid = 0;
  socketPath = '';
  private started = false;
  private serverStarted = false;
  private env: NodeJS.ProcessEnv = {};
  private panePids: number[] = [];

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

  async start(
    options: { mode?: 'respond' | 'silent' | 'malformed'; delayMs?: number } = {}
  ): Promise<void> {
    try {
      fs.mkdirSync(this.workspace, { recursive: true });
      fs.mkdirSync(this.globalDir, { recursive: true });
      fs.mkdirSync(this.wrapperDir, { recursive: true });
      fs.writeFileSync(
        path.join(this.wrapperDir, 'tmux'),
        `#!/bin/sh\nif [ "${'$'}{TMT_E2E_FORBID_TMUX:-}" = "1" ]; then\n  echo "unexpected tmux invocation" >> "$TMT_E2E_FORBIDDEN_TMUX_LOG"\n  exit 97\nfi\nexec ${shellQuote(this.tmuxPath)} -f /dev/null -L "$TMT_E2E_SOCKET" "$@"\n`
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
      await this.launchPrivateServer();
      this.started = true;
    } catch (error) {
      await this.stop();
      throw new Error(
        `E2E fixture failed to start its private tmux server: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  runCli<T = Record<string, unknown>>(
    args: string[],
    options: CliRunOptions = {}
  ): Promise<CliResult<T>> {
    if (!this.started) throw new Error('E2E fixture must be started before invoking the CLI.');
    const env: NodeJS.ProcessEnv = { ...this.env, TMUX_PANE: options.pane ?? this.pane };
    if (options.withoutTmux) {
      delete env.TMUX;
      delete env.TMUX_PANE;
      env.TMT_E2E_FORBID_TMUX = '1';
      env.TMT_E2E_FORBIDDEN_TMUX_LOG = this.forbiddenTmuxLogPath;
    }
    const child = spawn(binPath, args, {
      cwd: options.cwd ?? this.workspace,
      env,
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

  runJsonCli<T = Record<string, unknown>>(
    args: string[],
    options: CliRunOptions = {}
  ): Promise<CliResult<T>> {
    return this.runCli<T>(['--json', ...args], options);
  }

  createWorkspace(name: string): string {
    const workspace = path.join(this.root, name);
    fs.mkdirSync(workspace, { recursive: true });
    return workspace;
  }

  async createMockPane(name: string, workspace = this.workspace): Promise<MockPane> {
    if (!this.started) throw new Error('E2E fixture must be started before creating panes.');
    fs.mkdirSync(workspace, { recursive: true });
    const pane = this.tmux([
      'new-window',
      '-d',
      '-P',
      '-F',
      '#{pane_id}',
      '-t',
      'e2e',
      '-n',
      name,
      '-c',
      workspace,
      `${shellQuote(process.execPath)} ${shellQuote(mockAgentPath)}`,
    ]).trim();
    const pid = Number(this.tmux(['display-message', '-p', '-t', pane, '#{pane_pid}']).trim());
    if (!pane || !Number.isInteger(pid) || pid <= 0) {
      throw new Error(`E2E fixture could not create mock pane '${name}'.`);
    }
    this.panePids.push(pid);
    await this.waitForEvent((event) => event.event === 'ready' && event.pid === pid);
    return { pane, pid, workspace };
  }

  /**
   * Restart the fixture's private tmux server while retaining the fixture
   * environment and global directory. Pane user-options belong to a server,
   * so a fresh session is the authoritative persistence boundary for global
   * identities.
   */
  async restartServer(): Promise<MockPane> {
    if (!this.started) throw new Error('E2E fixture must be started before restarting its server.');

    const previousServerPid = this.serverPid;
    try {
      this.tmux(['kill-server']);
    } catch {
      // The server may have exited between the test operation and restart.
    }
    this.serverStarted = false;

    await this.waitFor(
      () => !this.processIsRunning(previousServerPid),
      2_000,
      'private tmux server to exit before restart'
    );

    return this.launchPrivateServer();
  }

  private async launchPrivateServer(): Promise<MockPane> {
    this.tmux([
      'new-session',
      '-d',
      '-s',
      'e2e',
      '-x',
      '160',
      '-y',
      '50',
      '-c',
      this.workspace,
      `${shellQuote(process.execPath)} ${shellQuote(mockAgentPath)}`,
    ]);
    this.serverStarted = true;
    this.socketPath = this.tmux(['display-message', '-p', '#{socket_path}']).trim();
    this.serverPid = Number(this.tmux(['display-message', '-p', '#{pid}']).trim());
    this.pane = this.tmux(['display-message', '-p', '-t', 'e2e:0.0', '#{pane_id}']).trim();
    this.panePid = Number(
      this.tmux(['display-message', '-p', '-t', this.pane, '#{pane_pid}']).trim()
    );
    if (!this.socketPath || !this.pane) {
      throw new Error('E2E fixture could not determine private server socket and pane ID.');
    }
    if (!Number.isInteger(this.panePid) || this.panePid <= 0) {
      throw new Error('E2E fixture could not determine mock-agent pane process ID.');
    }
    if (!Number.isInteger(this.serverPid) || this.serverPid <= 0) {
      throw new Error('E2E fixture could not determine private tmux server process ID.');
    }
    await this.waitForEvent((event) => event.event === 'ready' && event.pid === this.panePid);
    this.panePids.push(this.panePid);
    return { pane: this.pane, pid: this.panePid, workspace: this.workspace };
  }

  tmux(args: string[]): string {
    return execFileSync(path.join(this.wrapperDir, 'tmux'), args, {
      env: this.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  paneTarget(pane = this.pane): string {
    return this.tmux([
      'display-message',
      '-p',
      '-t',
      pane,
      '#{session_name}:#{window_index}.#{pane_index}',
    ]).trim();
  }

  paneMetadata(pane = this.pane): string {
    try {
      return this.tmux(['show-options', '-p', '-t', pane, '-v', '@tmux-team.agent']).trim();
    } catch {
      return '';
    }
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

  async waitForEvent(
    predicate: (event: MockEvent) => boolean,
    timeoutMs = 2_000
  ): Promise<MockEvent> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const event = this.events().find(predicate);
      if (event) return event;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(
      `Timed out waiting for mock-agent event. Events: ${JSON.stringify(this.events())}`
    );
  }

  async waitFor(
    predicate: () => boolean,
    timeoutMs = 2_000,
    description = 'condition'
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${description}.`);
  }

  async stop(): Promise<void> {
    if (this.serverStarted) {
      try {
        this.tmux(['kill-server']);
      } catch {
        // The server may already have exited; cleanup remains best effort.
      }
    }
    this.serverStarted = false;
    this.started = false;
    await this.waitForProcessExit();
    fs.rmSync(this.root, { recursive: true, force: true });
    fs.rmSync(this.socketRoot, { recursive: true, force: true });
  }

  serverIsRunning(): boolean {
    if (!this.socketPath) return false;
    try {
      execFileSync(this.tmuxPath, ['-S', this.socketPath, 'list-sessions'], {
        stdio: 'ignore',
      });
      return true;
    } catch {
      return this.serverProcessIsRunning();
    }
  }

  serverProcessIsRunning(): boolean {
    return this.processIsRunning(this.serverPid);
  }

  private processIsRunning(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  mockProcessIsRunning(pid = this.panePid): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async waitForProcessExit(timeoutMs = 2_000): Promise<void> {
    if (this.panePids.length === 0) return;
    const deadline = Date.now() + timeoutMs;
    while (
      Date.now() < deadline &&
      this.panePids.some((panePid) => this.mockProcessIsRunning(panePid))
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  sendMockInput(lines: string[], pane = this.pane): void {
    for (const line of lines) {
      execFileSync(
        path.join(this.wrapperDir, 'tmux'),
        ['send-keys', '-t', pane, '--', line, 'Enter'],
        {
          env: this.env,
          stdio: 'ignore',
        }
      );
    }
  }

  capture(lines = 100, pane = this.pane): string {
    return this.tmux(['capture-pane', '-p', '-t', pane, '-S', `-${lines}`]);
  }

  async waitForCapture(predicate: (output: string) => boolean, pane = this.pane): Promise<string> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const output = this.capture(100, pane);
      if (predicate(output)) return output;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for mock-agent pane output.\n${this.capture(100, pane)}`);
  }
}

export async function withE2EFixture<T>(
  callback: (fixture: E2EFixture) => Promise<T> | T,
  options: { mode?: 'respond' | 'silent' | 'malformed'; delayMs?: number } = {}
): Promise<T> {
  const fixture = new E2EFixture();
  try {
    await fixture.start(options);
    return await callback(fixture);
  } finally {
    await fixture.stop();
  }
}
