import { chmodSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCli, withSandbox } from '../support/cli-process.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rawVerifier = path.join(repositoryRoot, 'scripts/verify-native-runtime.mjs');
const { nativeHostTarget, verifyNativeRuntime } = (await import(
  pathToFileURL(path.join(repositoryRoot, 'scripts/native-runtime-proof.mjs')).href
)) as unknown as {
  nativeHostTarget: () => string;
  verifyNativeRuntime: (options: {
    executable: string;
    target: string;
    version: string;
    skill: string;
    profileContent: string;
    subject: string;
  }) => void;
};

describe('native runtime proof boundary', () => {
  it('requires explicit raw runtime inputs', async () => {
    await withSandbox(async (sandbox) => {
      const result = await runCli(
        {
          ...sandbox,
          cli: { executable: process.execPath, args: [rawVerifier] },
        },
        []
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('--executable is required');
    });
  });

  it('rejects a mismatched target before executing an arbitrary file', async () => {
    await withSandbox(async (sandbox) => {
      const executable = path.join(sandbox.root, 'not-native');
      const marker = path.join(sandbox.root, 'executed');
      writeFileSync(executable, `#!/bin/sh\n: > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
      chmodSync(executable, 0o755);
      const calibrated = await runCli(
        {
          ...sandbox,
          cli: { executable: '/bin/sh', args: [executable] },
        },
        []
      );
      expect(calibrated.status).toBe(0);
      expect(existsSync(marker)).toBe(true);
      unlinkSync(marker);
      const skill = path.join(sandbox.root, 'SKILL.md');
      writeFileSync(skill, 'skill\n');
      const result = await runCli(
        {
          ...sandbox,
          cli: { executable: process.execPath, args: [rawVerifier] },
        },
        [
          '--executable',
          executable,
          '--target',
          'unsupported-target',
          '--version',
          '5.0.0-test',
          '--skill',
          skill,
        ]
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('requires a matching native host');
      expect(existsSync(marker)).toBe(false);
    });
  });

  it('shared proof rejects a script instead of treating it as native support', async () => {
    await withSandbox(async (sandbox) => {
      const executable = path.join(sandbox.root, 'not-native');
      const marker = path.join(sandbox.root, 'executed');
      writeFileSync(executable, `#!/bin/sh\n: > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
      chmodSync(executable, 0o755);
      expect(() =>
        verifyNativeRuntime({
          executable,
          target: nativeHostTarget(),
          version: '5.0.0-test',
          skill: 'skill\n',
          profileContent: 'proof',
          subject: 'Native executable',
        })
      ).toThrow(
        process.platform === 'darwin'
          ? 'Mach-O dependency inventory is empty'
          : 'Native executable linkage inspection failed'
      );
      expect(existsSync(marker)).toBe(false);
    });
  });
});
