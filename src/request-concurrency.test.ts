import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import type { RequestAttemptRecord, RequestPreparation } from './request-service.js';
import { openIdentityRepository } from './storage/identity-repository.js';

const directories: string[] = [];
const WORKER_TIMEOUT_MS = 10_000;

interface WorkerResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly output: string;
}

interface WorkerHandle {
  readonly child: ChildProcess;
  readonly result: Promise<WorkerResult>;
  readonly variant: string;
}

interface WorkerMessage {
  readonly ok: boolean;
  readonly error?: string;
  readonly prepared?: RequestPreparation;
  readonly attempt?: RequestAttemptRecord;
}

function databaseFixture(): {
  directory: string;
  database: string;
  barrier: string;
  identity: string;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-request-race-'));
  directories.push(directory);
  const barrier = path.join(directory, 'barrier');
  fs.mkdirSync(barrier);
  const database = path.join(directory, 'tmux-team.db');
  const repository = openIdentityRepository(database);
  try {
    const identity = repository.createIdentity('Alice', 'alice');
    return { directory, database, barrier, identity: identity.id };
  } finally {
    repository.close();
  }
}

function runWorker(
  database: string,
  barrier: string,
  identity: string,
  variant: string,
  mode = 'prepare'
): WorkerHandle {
  const worker = path.join(process.cwd(), 'src/request-concurrency-worker.ts');
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', worker, database, barrier, identity, variant, mode],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const result = new Promise<WorkerResult>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal, output }));
    child.on('error', (error) => (output += `${String(error)}\n`));
  });
  return { child, result, variant };
}

function workerExited(handle: WorkerHandle): boolean {
  return handle.child.exitCode !== null || handle.child.signalCode !== null;
}

async function waitForFiles(
  names: readonly string[],
  handles: readonly WorkerHandle[]
): Promise<void> {
  const deadline = Date.now() + WORKER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (names.every((name) => fs.existsSync(name))) return;
    const exited = handles.find(
      (handle) =>
        workerExited(handle) &&
        names.some((name) => path.basename(name).endsWith(`-${handle.variant}`))
    );
    if (exited) {
      const result = await exited.result;
      throw new Error(`Worker exited before its barrier: ${result.output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for barriers: ${names.join(', ')}`);
}

async function collectResults(
  handles: readonly WorkerHandle[],
  timeoutMs = WORKER_TIMEOUT_MS
): Promise<WorkerResult[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.all(handles.map((handle) => handle.result)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Timed out waiting for worker processes.')),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function stopWorkers(handles: readonly WorkerHandle[]): Promise<void> {
  for (const handle of handles) {
    if (!workerExited(handle)) handle.child.kill('SIGTERM');
  }
  try {
    await collectResults(handles, 1_000);
  } catch {
    // Escalate any worker that did not honor the bounded graceful shutdown.
  }
  for (const handle of handles) {
    if (!workerExited(handle)) handle.child.kill('SIGKILL');
  }
  try {
    await collectResults(handles, 1_000);
  } catch {
    // The explicit survivor check below turns an incomplete cleanup into a test failure.
  }
  const survivors = handles.filter((handle) => !workerExited(handle));
  if (survivors.length > 0) {
    throw new Error(
      `Workers survived termination: ${survivors.map((handle) => handle.variant).join(', ')}`
    );
  }
}

function workerMessage(result: WorkerResult): WorkerMessage {
  if (result.code !== 0) throw new Error(`Worker failed (${result.signal}): ${result.output}`);
  const lines = result.output.trim().split('\n');
  const line = lines.at(-1);
  if (!line) throw new Error('Worker produced no result.');
  return JSON.parse(line) as WorkerMessage;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('request service multi-process races', () => {
  it('serializes same-identity cadence reservations without losing attempts or injections', async () => {
    const fixture = databaseFixture();
    const variants = Array.from({ length: 8 }, (_, index) => `same-${index}`);
    const handles = variants.map((variant) =>
      runWorker(fixture.database, fixture.barrier, fixture.identity, variant)
    );
    try {
      await waitForFiles(
        variants.map((variant) => path.join(fixture.barrier, `ready-${variant}`)),
        handles
      );
      fs.writeFileSync(path.join(fixture.barrier, 'go'), 'go');
      const results = await collectResults(handles);
      const messages = results.map(workerMessage);
      expect(messages.every((message) => message.ok)).toBe(true);

      const repository = openIdentityRepository(fixture.database);
      try {
        const attempts = repository.listAttempts();
        expect(attempts).toHaveLength(variants.length);
        expect(new Set(attempts.map((attempt) => attempt.attemptId)).size).toBe(variants.length);
        expect(new Set(attempts.map((attempt) => attempt.requestId)).size).toBe(variants.length);
        expect(attempts.every((attempt) => attempt.identityId === fixture.identity)).toBe(true);
        expect(attempts.every((attempt) => attempt.waitActive)).toBe(true);
        expect(attempts.filter((attempt) => attempt.injectPreamble)).toHaveLength(
          Math.ceil(variants.length / 3)
        );
        expect(repository.getPreambleCount(fixture.identity)).toBe(variants.length);
      } finally {
        repository.close();
      }
    } finally {
      await stopWorkers(handles);
    }
  }, 15_000);

  it('keeps same-pane waits independent when server endpoint evidence differs', async () => {
    const fixture = databaseFixture();
    const handles = ['a', 'b'].map((variant) =>
      runWorker(fixture.database, fixture.barrier, fixture.identity, variant, 'different-endpoint')
    );
    try {
      await waitForFiles(
        ['a', 'b'].map((variant) => path.join(fixture.barrier, `ready-${variant}`)),
        handles
      );
      fs.writeFileSync(path.join(fixture.barrier, 'go'), 'go');
      const results = await collectResults(handles);
      const messages = results.map(workerMessage);
      expect(messages.every((message) => message.ok)).toBe(true);
      expect(messages.every((message) => message.prepared?.previousRequestId === undefined)).toBe(
        true
      );

      const repository = openIdentityRepository(fixture.database);
      try {
        const attempts = repository.listAttempts();
        expect(attempts).toHaveLength(2);
        expect(new Set(attempts.map((attempt) => attempt.serverId)).size).toBe(2);
        expect(new Set(attempts.map((attempt) => attempt.socketPath)).size).toBe(2);
        expect(new Set(attempts.map((attempt) => attempt.serverStartTime)).size).toBe(2);
        expect(attempts.every((attempt) => attempt.paneId === '%same-pane')).toBe(true);
        expect(attempts.every((attempt) => attempt.waitActive)).toBe(true);
      } finally {
        repository.close();
      }
    } finally {
      await stopWorkers(handles);
    }
  }, 15_000);

  it('releases exactly one attempt without changing another waiter', async () => {
    const fixture = databaseFixture();
    const handles = ['a', 'b'].map((variant) =>
      runWorker(fixture.database, fixture.barrier, fixture.identity, variant, 'release')
    );
    try {
      await waitForFiles(
        ['a', 'b'].map((variant) => path.join(fixture.barrier, `ready-${variant}`)),
        handles
      );
      fs.writeFileSync(path.join(fixture.barrier, 'go'), 'go');
      await waitForFiles(
        ['a', 'b'].map((variant) => path.join(fixture.barrier, `prepared-${variant}`)),
        handles
      );
      fs.writeFileSync(path.join(fixture.barrier, 'release-a'), 'release');
      await waitForFiles([path.join(fixture.barrier, 'released-a')], handles);

      const repository = openIdentityRepository(fixture.database);
      try {
        const attempts = repository.listAttempts();
        expect(attempts).toHaveLength(2);
        expect(attempts.find((attempt) => attempt.requestId === 'request-a')?.waitActive).toBe(
          false
        );
        expect(attempts.find((attempt) => attempt.requestId === 'request-b')?.waitActive).toBe(
          true
        );
      } finally {
        repository.close();
      }

      fs.writeFileSync(path.join(fixture.barrier, 'release-b'), 'release');
      await waitForFiles([path.join(fixture.barrier, 'released-b')], handles);
      const results = await collectResults(handles);
      expect(results.map(workerMessage).every((message) => message.ok)).toBe(true);

      const verification = openIdentityRepository(fixture.database);
      try {
        expect(verification.listAttempts().every((attempt) => !attempt.waitActive)).toBe(true);
      } finally {
        verification.close();
      }
    } finally {
      await stopWorkers(handles);
    }
  }, 15_000);

  it('rolls back an uncommitted attempt and cadence mutation after SIGKILL', async () => {
    const fixture = databaseFixture();
    const handle = runWorker(
      fixture.database,
      fixture.barrier,
      fixture.identity,
      'kill',
      'rollback'
    );
    try {
      await waitForFiles([path.join(fixture.barrier, 'transaction-open-kill')], [handle]);
      expect(handle.child.kill('SIGKILL')).toBe(true);
      const [result] = await collectResults([handle]);
      expect(result.signal).toBe('SIGKILL');

      const repository = openIdentityRepository(fixture.database);
      try {
        const attempts = repository.listAttempts();
        expect(attempts).toHaveLength(1);
        expect(attempts[0]?.requestId).toBe('request-baseline-kill');
        expect(attempts.some((attempt) => attempt.requestId === 'request-uncommitted-kill')).toBe(
          false
        );
        expect(repository.getPreambleCount(fixture.identity)).toBe(1);
      } finally {
        repository.close();
      }
    } finally {
      await stopWorkers([handle]);
    }
  }, 15_000);
});
