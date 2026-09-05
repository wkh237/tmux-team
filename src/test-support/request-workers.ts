import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

export const WORKER_TIMEOUT_MS = 10_000;

export interface WorkerResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly output: string;
}

export interface WorkerHandle {
  readonly child: ChildProcess;
  readonly result: Promise<WorkerResult>;
  readonly variant: string;
}

export function runWorker(
  worker: string,
  args: readonly string[],
  variant: string,
  cwd = process.cwd()
): WorkerHandle {
  const child = spawn(process.execPath, ['--import', 'tsx', worker, ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const result = new Promise<WorkerResult>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal, output }));
    child.on('error', (error) => (output += `${String(error)}\n`));
  });
  return { child, result, variant };
}

export function workerExited(handle: WorkerHandle): boolean {
  return handle.child.exitCode !== null || handle.child.signalCode !== null;
}

export async function waitForFiles(
  names: readonly string[],
  handles: readonly WorkerHandle[],
  exitedBeforeBarrier = (handle: WorkerHandle, barrierNames: readonly string[]) =>
    barrierNames.some((name) => path.basename(name).endsWith(`-${handle.variant}`))
): Promise<void> {
  const deadline = Date.now() + WORKER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (names.every((name) => fs.existsSync(name))) return;
    const exited = handles.find(
      (handle) => workerExited(handle) && exitedBeforeBarrier(handle, names)
    );
    if (exited) {
      const result = await exited.result;
      throw new Error(`Worker exited before its barrier: ${result.output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for barriers: ${names.join(', ')}`);
}

export async function collectResults(
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

export async function stopWorkers(handles: readonly WorkerHandle[]): Promise<void> {
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

export function workerMessage<T>(result: WorkerResult): T {
  if (result.code !== 0) throw new Error(`Worker failed (${result.signal}): ${result.output}`);
  const lines = result.output.trim().split('\n');
  const line = lines.at(-1);
  if (!line) throw new Error('Worker produced no result.');
  return JSON.parse(line) as T;
}
