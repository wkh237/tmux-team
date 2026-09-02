#!/usr/bin/env node

import { spawn } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const image = `tmux-team-e2e:${process.pid}-${Date.now().toString(36)}`;
const dockerfile = path.join(repoRoot, 'test', 'e2e', 'Dockerfile');
let activeChild;
let interrupted = false;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: 'inherit', ...options });
    activeChild = child;
    let settled = false;
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      if (activeChild === child) activeChild = undefined;
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (activeChild === child) activeChild = undefined;
      resolve(code ?? 1);
    });
  });
}

function forwardSignal(signal) {
  interrupted = true;
  activeChild?.kill(signal);
}

process.once('SIGINT', () => forwardSignal('SIGINT'));
process.once('SIGTERM', () => forwardSignal('SIGTERM'));

async function removeImage() {
  try {
    await run('docker', ['image', 'rm', '--force', image], { stdio: 'ignore' });
  } catch {
    // Preserve the primary build/test failure when cleanup cannot run.
  }
}

async function main() {
  try {
    const buildStatus = await run('docker', [
      'build',
      '--tag',
      image,
      '--file',
      dockerfile,
      repoRoot,
    ]);
    if (buildStatus !== 0) return interrupted ? 130 : buildStatus;
    if (interrupted) return 130;
    const testStatus = await run('docker', ['run', '--rm', '--init', '--network', 'none', image]);
    return interrupted ? 130 : testStatus;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      console.error('E2E setup failed: Docker is required but was not found on PATH.');
    } else {
      console.error(`E2E setup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 1;
  } finally {
    await removeImage();
  }
}

main().then((code) => {
  process.exitCode = code;
});
