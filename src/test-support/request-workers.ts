import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const WORKER_TIMEOUT_MS = 10_000;
export const WORKER_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const TSX_LOADER = createRequire(import.meta.url).resolve('tsx');

export interface WorkerResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly output: string;
  readonly outputExceeded: boolean;
}

export interface WorkerHandle {
  readonly child: ChildProcess;
  readonly result: Promise<WorkerResult>;
  readonly variant: string;
  readonly isExited: () => boolean;
}

export function runWorker(
  worker: string | URL,
  args: readonly string[],
  variant: string,
  cwd = process.cwd()
): WorkerHandle {
  const workerPath = worker instanceof URL ? fileURLToPath(worker) : worker;
  const child = spawn(process.execPath, ['--import', TSX_LOADER, workerPath, ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let spawnFailed = false;
  let closed = false;
  let output = '';
  let outputBytes = 0;
  let outputExceeded = false;
  const captureOutput = (chunk: string): void => {
    const bytes = Buffer.from(chunk);
    const remaining = Math.max(0, WORKER_OUTPUT_LIMIT_BYTES - outputBytes);
    if (remaining > 0) output += bytes.subarray(0, remaining).toString();
    outputBytes += bytes.byteLength;
    if (outputBytes > WORKER_OUTPUT_LIMIT_BYTES && !outputExceeded) {
      outputExceeded = true;
      output += `\nWorker output exceeded ${WORKER_OUTPUT_LIMIT_BYTES} bytes.\n`;
      child.kill('SIGKILL');
    }
  };
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', captureOutput);
  child.stderr?.on('data', captureOutput);
  const result = new Promise<WorkerResult>((resolve) => {
    child.on('close', (code, signal) => {
      closed = true;
      resolve({ code, signal, output, outputExceeded });
    });
    child.on('error', (error) => {
      if (child.pid === undefined) spawnFailed = true;
      captureOutput(`${String(error)}\n`);
    });
  });
  return { child, result, variant, isExited: () => spawnFailed || closed };
}

export function workerExited(handle: WorkerHandle): boolean {
  return handle.child.exitCode !== null || handle.child.signalCode !== null || handle.isExited();
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
  if (result.outputExceeded) {
    throw new Error(`Worker output exceeded ${WORKER_OUTPUT_LIMIT_BYTES} bytes.`);
  }
  if (result.code !== 0) throw new Error(`Worker failed (${result.signal}): ${result.output}`);
  const lines = result.output.trim().split('\n');
  const line = lines.at(-1);
  if (!line) throw new Error('Worker produced no result.');
  return JSON.parse(line) as T;
}
