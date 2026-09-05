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
  response?: string;
  responseLength?: number;
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
  /** Remove caller context while keeping tmux available for explicit targets. */
  outsideTmux?: boolean;
  /** Narrow caller-context overrides for invalid-evidence scenarios. */
  caller?: {
    tmux?: string | null;
    pane?: string | null;
  };
  /** Touch this file when the child has made its first tmux invocation. */
  progressFile?: string;
}

export interface CliProcess<T = unknown> {
  readonly pid: number;
  readonly result: Promise<CliResult<T>>;
  /** Kill the CLI and descendants, including a paused tmux wrapper. */
  kill(signal?: NodeJS.Signals): void;
}

export interface MetadataBarrierOptions {
  /** Pause before or after the real durable metadata set-option. */
  readonly phase: 'before' | 'after';
  /** Publication is the default; clear pauses durable metadata removal. */
  readonly operation?: 'publish' | 'clear';
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
  readonly globalDir: string;
  readonly logPath = path.join(this.root, 'mock-agent.jsonl');
  readonly forbiddenTmuxLogPath = path.join(this.root, 'forbidden-tmux.log');
  readonly metadataBarrierDirectory = path.join(this.root, 'metadata-barrier');
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
  private cliProcessPids = new Set<number>();
  private cliProcessResults = new Map<number, Promise<CliResult<unknown>>>();

  constructor(options: { globalDir?: string } = {}) {
    this.globalDir = options.globalDir ?? path.join(this.root, 'global');
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
    options: {
      mode?: 'respond' | 'silent' | 'malformed' | 'virtualized';
      delayMs?: number;
      metadataBarrier?: MetadataBarrierOptions;
    } = {}
  ): Promise<void> {
    try {
      fs.mkdirSync(this.workspace, { recursive: true });
      fs.mkdirSync(this.globalDir, { recursive: true });
      fs.mkdirSync(this.wrapperDir, { recursive: true });
      if (options.metadataBarrier) fs.mkdirSync(this.metadataBarrierDirectory);
      fs.writeFileSync(
        path.join(this.wrapperDir, 'tmux'),
        `#!/bin/sh
if [ "${'$'}{TMT_E2E_FORBID_TMUX:-}" = "1" ]; then
  echo "unexpected tmux invocation" >> "${'$'}TMT_E2E_FORBIDDEN_TMUX_LOG"
  exit 97
fi
if [ -n "${'$'}{TMT_E2E_PROGRESS_FILE:-}" ]; then
  : > "${'$'}TMT_E2E_PROGRESS_FILE"
fi
metadata_write=0
metadata_clear=0
if [ "${'$'}1" = "set-option" ]; then
  unset_metadata=0
  pane_metadata=0
  for arg in "${'$'}@"; do
    if [ "${'$'}arg" = "-u" ]; then unset_metadata=1; fi
    if [ "${'$'}arg" = "-p" ]; then pane_metadata=1; fi
    if [ "${'$'}arg" = "@tmux-team.agent" ]; then metadata_write=1; fi
  done
  if [ "${'$'}unset_metadata" = "1" ] && [ "${'$'}pane_metadata" = "1" ] && [ "${'$'}metadata_write" = "1" ]; then
    metadata_clear=1
  fi
  if [ "${'$'}unset_metadata" = "1" ] || [ "${'$'}pane_metadata" = "0" ]; then
    metadata_write=0
  fi
fi
if [ -z "${'$'}{TMT_E2E_PROGRESS_FILE:-}" ] && [ -z "${'$'}{TMT_E2E_METADATA_BARRIER_DIR:-}" ]; then
  exec ${shellQuote(this.tmuxPath)} -f /dev/null -L "${'$'}TMT_E2E_SOCKET" "${'$'}@"
fi
metadata_target=0
if [ "${'$'}{TMT_E2E_METADATA_BARRIER_OPERATION:-publish}" = "clear" ]; then
  metadata_target=${'$'}metadata_clear
else
  metadata_target=${'$'}metadata_write
fi
if [ "${'$'}metadata_target" = "1" ] && [ -n "${'$'}{TMT_E2E_METADATA_BARRIER_DIR:-}" ]; then
  : > "${'$'}TMT_E2E_METADATA_BARRIER_DIR/entered"
  if [ "${'$'}{TMT_E2E_METADATA_BARRIER_PHASE:-}" = "before" ]; then
    barrier_wait=0
    while [ ! -e "${'$'}TMT_E2E_METADATA_BARRIER_DIR/release" ] && [ "${'$'}barrier_wait" -lt 200 ]; do
      sleep 0.01
      barrier_wait=${'$'}((barrier_wait + 1))
    done
    [ -e "${'$'}TMT_E2E_METADATA_BARRIER_DIR/release" ] || exit 124
  fi
fi
${shellQuote(this.tmuxPath)} -f /dev/null -L "${'$'}TMT_E2E_SOCKET" "${'$'}@"
status=${'$'}?
if [ "${'$'}metadata_target" = "1" ] && [ -n "${'$'}{TMT_E2E_METADATA_BARRIER_DIR:-}" ] && [ "${'$'}{TMT_E2E_METADATA_BARRIER_PHASE:-}" = "after" ]; then
  : > "${'$'}TMT_E2E_METADATA_BARRIER_DIR/applied"
  barrier_wait=0
  while [ ! -e "${'$'}TMT_E2E_METADATA_BARRIER_DIR/release" ] && [ "${'$'}barrier_wait" -lt 200 ]; do
    sleep 0.01
    barrier_wait=${'$'}((barrier_wait + 1))
  done
  [ -e "${'$'}TMT_E2E_METADATA_BARRIER_DIR/release" ] || exit 124
fi
exit ${'$'}status
`
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
      if (options.metadataBarrier) {
        this.enableMetadataBarrier(options.metadataBarrier);
      }
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
    return this.runCliProcess<T>(args, options).result;
  }

  runCliProcess<T = Record<string, unknown>>(
    args: string[],
    options: CliRunOptions = {}
  ): CliProcess<T> {
    if (!this.started) throw new Error('E2E fixture must be started before invoking the CLI.');
    const env: NodeJS.ProcessEnv = { ...this.env };
    if (!options.outsideTmux && !options.withoutTmux) {
      const callerPane = options.pane ?? this.pane;
      env.TMUX = `${this.socketPath},${this.serverPid},${this.paneSessionId(callerPane)}`;
      env.TMUX_PANE = callerPane;
      if (options.caller) {
        if (options.caller.tmux === null) delete env.TMUX;
        else if (options.caller.tmux !== undefined) env.TMUX = options.caller.tmux;
        if (options.caller.pane === null) delete env.TMUX_PANE;
        else if (options.caller.pane !== undefined) env.TMUX_PANE = options.caller.pane;
      }
    } else {
      delete env.TMUX;
      delete env.TMUX_PANE;
    }
    if (options.withoutTmux) {
      delete env.TMUX;
      delete env.TMUX_PANE;
      env.TMT_E2E_FORBID_TMUX = '1';
      env.TMT_E2E_FORBIDDEN_TMUX_LOG = this.forbiddenTmuxLogPath;
    }
    if (options.progressFile) env.TMT_E2E_PROGRESS_FILE = options.progressFile;
    const child = spawn(binPath, args, {
      cwd: options.cwd ?? this.workspace,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.pid) this.cliProcessPids.add(child.pid);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const result = new Promise<CliResult<T>>((resolve) => {
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
    if (child.pid) this.cliProcessResults.set(child.pid, result as Promise<CliResult<unknown>>);
    void result.then(
      () => {
        if (child.pid) {
          try {
            if (!this.processGroupIsRunning(child.pid)) this.cliProcessPids.delete(child.pid);
          } catch {
            // Leave the group tracked so fixture cleanup reports the failure.
          }
          this.cliProcessResults.delete(child.pid);
        }
      },
      () => {
        if (child.pid) {
          try {
            if (!this.processGroupIsRunning(child.pid)) this.cliProcessPids.delete(child.pid);
          } catch {
            // Leave the group tracked so fixture cleanup reports the failure.
          }
          this.cliProcessResults.delete(child.pid);
        }
      }
    );
    return {
      pid: child.pid ?? 0,
      result,
      kill(signal = 'SIGTERM') {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') {
            throw error;
          }
        }
      },
    };
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

  paneSessionId(pane = this.pane): string {
    return this.tmux(['display-message', '-p', '-t', pane, '#{session_id}'])
      .trim()
      .replace(/^\$/, '');
  }

  paneMetadata(pane = this.pane): string {
    try {
      return this.tmux(['show-options', '-p', '-t', pane, '-v', '@tmux-team.agent']).trim();
    } catch {
      return '';
    }
  }

  paneTitle(pane = this.pane): string {
    return this.tmux(['display-message', '-p', '-t', pane, '#{pane_title}']).trim();
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

  async waitForMetadataBarrier(
    signal: 'entered' | 'applied' = 'entered',
    timeoutMs = 900
  ): Promise<void> {
    await this.waitFor(
      () => fs.existsSync(path.join(this.metadataBarrierDirectory, signal)),
      timeoutMs,
      `metadata barrier '${signal}'`
    );
  }

  releaseMetadataBarrier(): void {
    if (!fs.existsSync(this.metadataBarrierDirectory)) {
      throw new Error('Metadata barrier is not enabled for this fixture.');
    }
    fs.writeFileSync(path.join(this.metadataBarrierDirectory, 'release'), 'release');
  }

  enableMetadataBarrier(options: MetadataBarrierOptions): void {
    fs.mkdirSync(this.metadataBarrierDirectory, { recursive: true });
    for (const signal of ['entered', 'applied', 'release']) {
      fs.rmSync(path.join(this.metadataBarrierDirectory, signal), { force: true });
    }
    this.env.TMT_E2E_METADATA_BARRIER_DIR = this.metadataBarrierDirectory;
    this.env.TMT_E2E_METADATA_BARRIER_PHASE = options.phase;
    this.env.TMT_E2E_METADATA_BARRIER_OPERATION = options.operation ?? 'publish';
  }

  async stop(): Promise<void> {
    const cliPids = [...this.cliProcessPids];
    let cleanupError: Error | undefined;
    for (const pid of cliPids) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') {
          cleanupError = new Error(`Could not kill E2E CLI process group ${pid}.`, {
            cause: error,
          });
        }
      }
    }
    const groupsRunning = (): number[] =>
      cliPids.filter((pid) => {
        try {
          return this.processGroupIsRunning(pid);
        } catch (error) {
          cleanupError ??= new Error(`Could not inspect E2E CLI process group ${pid}.`, {
            cause: error,
          });
          return false;
        }
      });
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && groupsRunning().length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const survivors = groupsRunning();
    if (survivors.length > 0) {
      cleanupError = new Error(`E2E CLI process groups survived cleanup: ${survivors.join(', ')}`);
    }
    this.cliProcessPids.clear();
    await Promise.race([
      Promise.allSettled(this.cliProcessResults.values()),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
    if (this.cliProcessResults.size > 0) {
      cleanupError = new Error(
        `E2E CLI processes did not report termination: ${[...this.cliProcessResults.keys()].join(', ')}`
      );
    }
    this.cliProcessResults.clear();
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
    if (cleanupError) throw cleanupError;
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

  private processGroupIsRunning(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
      throw error;
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
  options: {
    mode?: 'respond' | 'silent' | 'malformed' | 'virtualized';
    delayMs?: number;
    globalDir?: string;
    metadataBarrier?: MetadataBarrierOptions;
  } = {}
): Promise<T> {
  const fixture = new E2EFixture(options);
  try {
    await fixture.start(options);
    return await callback(fixture);
  } finally {
    await fixture.stop();
  }
}
