import fs from 'node:fs';

export function waitForBarrier(file: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for barrier '${file}'.`);
    Atomics.wait(sleepBuffer, 0, 0, 10);
  }
}
