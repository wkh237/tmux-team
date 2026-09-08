import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { runCli, type Sandbox } from '../../src/test-support/cli-process.js';

/** A task-owned executable that fails visibly instead of touching host tmux. */
export function installTmuxTripwire(sandbox: Sandbox): string {
  const directory = path.join(sandbox.root, 'task-owned-tripwire');
  const logPath = path.join(sandbox.root, 'tmux-invocations.log');
  mkdirSync(directory);
  const executable = path.join(directory, 'tmux');
  writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TMT_TEST_TMUX_LOG"\nexit 97\n');
  chmodSync(executable, 0o755);
  sandbox.env.PATH = `${directory}${path.delimiter}${sandbox.env.PATH ?? ''}`;
  sandbox.env.TMT_TEST_TMUX_LOG = logPath;
  return logPath;
}

export async function calibrateTmuxTripwire(sandbox: Sandbox): Promise<string> {
  const logPath = installTmuxTripwire(sandbox);
  const result = await runCli(
    { ...sandbox, cli: { executable: '/usr/bin/env', args: ['tmux'] } },
    [],
    { deadlineMs: 2_000 }
  );
  expect(result.status).toBe(97);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
  expect(readFileSync(logPath, 'utf8')).toBe('\n');
  return logPath;
}
