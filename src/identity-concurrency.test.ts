import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { openIdentityRepository } from './storage/identity-repository.js';

const directories: string[] = [];
function runWorker(
  worker: string,
  databaseFile: string,
  barrierDirectory: string,
  variant: string
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', worker, databaseFile, barrierDirectory, variant],
      {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('close', (code) => resolve({ code, output }));
  });
}

afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('identity repository multi-process races', () => {
  it('converges equivalent names to one identity and one binding', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-concurrency-'));
    directories.push(directory);
    const barrier = path.join(directory, 'barrier');
    fs.mkdirSync(barrier);
    const databaseFile = path.join(directory, 'tmux-team.db');
    const worker = path.join(process.cwd(), 'src/identity-concurrency-worker.ts');
    const first = runWorker(worker, databaseFile, barrier, 'a');
    const second = runWorker(worker, databaseFile, barrier, 'b');
    for (
      let i = 0;
      i < 100 &&
      (!fs.existsSync(path.join(barrier, 'ready-a')) ||
        !fs.existsSync(path.join(barrier, 'ready-b')));
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fs.existsSync(path.join(barrier, 'ready-a'))).toBe(true);
    expect(fs.existsSync(path.join(barrier, 'ready-b'))).toBe(true);
    fs.writeFileSync(path.join(barrier, 'go'), 'go');
    const results = await Promise.all([first, second]);
    expect(results.every((result) => result.code === 0)).toBe(true);
    const ids = results.map((result) => JSON.parse(result.output.trim()).id);
    expect(ids[0]).toBe(ids[1]);
    const repository = openIdentityRepository(databaseFile);
    expect(repository.listIdentities()).toHaveLength(1);
    expect(repository.findBindings()).toHaveLength(1);
    expect(repository.findBindings()[0]?.identityId).toBe(ids[0]);
    repository.close();
  }, 15_000);
});
