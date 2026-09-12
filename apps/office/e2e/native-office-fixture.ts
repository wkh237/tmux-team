import path from 'node:path';
import { expect } from '@playwright/test';
import { createArtifact } from '../../../test/support/native-artifact.js';
import { runCli, type Sandbox } from '../../../test/support/cli-process.js';

export async function installNativeOffice(sandbox: Sandbox): Promise<string> {
  const artifact = await createArtifact(
    sandbox,
    '0.1.0-alpha.1',
    new Uint8Array(),
    'office',
    path.resolve('../../rust/target/debug/tmt-office')
  );
  const prefix = path.join(sandbox.root, 'office-prefix');
  const installed = await runCli(
    sandbox,
    [
      'office',
      'install',
      '--yes',
      '--prefix',
      prefix,
      '--archive',
      artifact.archive,
      '--manifest',
      artifact.manifest,
      '--json',
    ],
    { deadlineMs: 20_000 }
  );
  expect(installed.status, installed.stdout).toBe(0);
  expect(installed.stderr).toBe('');
  return prefix;
}

export function protectedOfficeRecord(
  sandbox: Sandbox,
  scopeKey: string,
  operation: 'lookup' | 'store' | 'clear',
  input?: string
) {
  return runCli(
    { ...sandbox, cli: { executable: '/usr/bin/secret-tool', args: [] } },
    [
      operation,
      ...(operation === 'store' ? ['--label', 'Native Office fixture'] : []),
      'service',
      'org.tmux-team.office.v1',
      'username',
      scopeKey,
    ],
    input === undefined ? {} : { stdin: input }
  );
}
