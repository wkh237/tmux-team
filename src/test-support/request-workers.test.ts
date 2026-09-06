import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WORKER_OUTPUT_LIMIT_BYTES,
  collectResults,
  runWorker,
  stopWorkers,
  waitForFiles,
  workerMessage,
  workerExited,
  type WorkerHandle,
} from './request-workers.js';
import { waitForBarrier } from './workers/barrier.js';

const directories: string[] = [];

function fixture(): { directory: string; barrier: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-worker-lifecycle-'));
  directories.push(directory);
  const barrier = path.join(directory, 'barrier');
  fs.mkdirSync(barrier);
  return { directory, barrier };
}

function processExists(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('concurrency worker lifecycle', () => {
  it('stops all workers when the parent fails before releasing the barrier', async () => {
    const value = fixture();
    const worker = new URL('./workers/identity-concurrency-worker.ts', import.meta.url);
    const handles = ['a', 'b'].map((variant) =>
      runWorker(
        worker,
        [path.join(value.directory, 'missing.db'), value.barrier, variant],
        variant,
        value.directory
      )
    );
    const pids = handles.map((handle) => handle.child.pid);
    await expect(
      (async () => {
        try {
          await waitForFiles(
            ['a', 'b'].map((variant) => path.join(value.barrier, `ready-${variant}`)),
            handles
          );
          throw new Error('simulated parent failure before go');
        } finally {
          await stopWorkers(handles);
        }
      })()
    ).rejects.toThrow('simulated parent failure before go');
    expect(fs.existsSync(path.join(value.barrier, 'go'))).toBe(false);
    expect(handles.every(workerExited)).toBe(true);
    expect(pids.every((pid) => !processExists(pid))).toBe(true);
  }, 15_000);

  it('reports an early worker exit instead of waiting indefinitely for readiness', async () => {
    const value = fixture();
    const worker = new URL('./workers/identity-concurrency-worker.ts', import.meta.url);
    const handle = runWorker(worker, [], 'early', value.directory);
    try {
      await expect(
        waitForFiles([path.join(value.barrier, 'ready-early')], [handle])
      ).rejects.toThrow('Worker exited before its barrier');
    } finally {
      await stopWorkers([handle]);
    }
    expect(workerExited(handle)).toBe(true);
    expect(processExists(handle.child.pid)).toBe(false);
  }, 15_000);

  it('escalates a child that ignores graceful termination to bounded SIGKILL cleanup', async () => {
    const value = fixture();
    const ready = path.join(value.barrier, 'ready-stubborn');
    const worker = new URL('./fixtures/ignore-term.ts', import.meta.url);
    const handle: WorkerHandle = runWorker(worker, [ready], 'stubborn', value.directory);
    try {
      await waitForFiles([ready], [handle]);
    } finally {
      await stopWorkers([handle]);
    }
    const [result] = await collectResults([handle], 2_000);
    expect(result.signal).toBe('SIGKILL');
    expect(workerExited(handle)).toBe(true);
    expect(processExists(handle.child.pid)).toBe(false);
  }, 15_000);

  it('reports a failed spawn without leaving an untracked child', async () => {
    const value = fixture();
    const worker = new URL('./workers/identity-concurrency-worker.ts', import.meta.url);
    const handle = runWorker(worker, [], 'spawn-error', path.join(value.directory, 'missing-cwd'));
    try {
      await expect(
        waitForFiles([path.join(value.barrier, 'ready-spawn-error')], [handle])
      ).rejects.toThrow('Worker exited before its barrier');
    } finally {
      await stopWorkers([handle]);
    }
    expect(workerExited(handle)).toBe(true);
    expect(processExists(handle.child.pid)).toBe(false);
  }, 15_000);

  it('bounds worker output and rejects an exceeded zero-exit result explicitly', async () => {
    const value = fixture();
    const worker = new URL('./fixtures/large-output.ts', import.meta.url);
    const handle = runWorker(worker, [], 'large-output', value.directory);
    const pid = handle.child.pid;
    try {
      const [result] = await collectResults([handle], 2_000);
      expect(result.outputExceeded).toBe(true);
      expect(result.output.length).toBeLessThanOrEqual(WORKER_OUTPUT_LIMIT_BYTES + 100);
      expect(() => workerMessage(result)).toThrow('Worker output exceeded');
    } finally {
      await stopWorkers([handle]);
    }
    expect(workerExited(handle)).toBe(true);
    expect(processExists(pid)).toBe(false);
    expect(() =>
      workerMessage({
        code: 0,
        signal: null,
        output: '{"message":"complete"}',
        outputExceeded: true,
      })
    ).toThrow('Worker output exceeded');
  }, 15_000);

  it('reassembles a UTF-8 character split across worker output chunks', async () => {
    const value = fixture();
    const worker = new URL('./fixtures/split-utf8.ts', import.meta.url);
    const handle = runWorker(worker, [value.barrier], 'split-utf8', value.directory);
    const pid = handle.child.pid;
    try {
      await waitForFiles([path.join(value.barrier, 'first-byte-written')], [handle]);
      fs.writeFileSync(path.join(value.barrier, 'go'), 'go');
      const [result] = await collectResults([handle], 2_000);
      expect(workerMessage<{ message: string }>(result)).toEqual({ message: '😀' });
    } finally {
      await stopWorkers([handle]);
    }
    expect(workerExited(handle)).toBe(true);
    expect(processExists(pid)).toBe(false);
  }, 15_000);

  it('accepts an existing barrier with zero budget and rejects a missing one', () => {
    const value = fixture();
    const existing = path.join(value.barrier, 'existing');
    fs.writeFileSync(existing, 'ready');
    expect(() => waitForBarrier(existing, 0)).not.toThrow();
    expect(() => waitForBarrier(path.join(value.barrier, 'missing'), 0)).toThrow(
      'Timed out waiting for barrier'
    );
  });
});
