import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  expectError,
  fileSnapshot,
  runCli,
  withSandbox,
} from '../../src/test-support/cli-process.js';

// This suite is deliberately native-preview-specific. Requiring the shared
// descriptor prevents an omitted build from silently exercising TypeScript.
if (!process.env.TMT_TEST_CLI) throw new Error('Select the native build with TMT_TEST_CLI.');

describe('native grammar preview process contract', () => {
  it('generates valid shells without offering rejected or unrelated options', async () => {
    await withSandbox(async (sandbox) => {
      for (const shell of ['bash', 'zsh']) {
        const completion = await runCli(sandbox, ['completion', shell]);
        expect(completion.status).toBe(0);
        expect(completion.stderr).toBe('');
        expect(completion.stdout).toContain('--save');
        expect(completion.stdout).not.toContain('--wait');
        expect(completion.stdout).not.toContain('--team');
        expect(completion.stdout).not.toContain('--config');
        execFileSync(shell, ['-n', '-c', completion.stdout], {
          env: sandbox.env,
          cwd: sandbox.cwd,
          timeout: 5000,
          maxBuffer: 1024 * 1024,
        });
        if (shell === 'bash') {
          const probe = `${completion.stdout}\nCOMP_WORDS=(tmt x ackall --)\nCOMP_CWORD=3\n_tmt tmt -- ackall\nprintf '%s\\n' "\${COMPREPLY[@]}"`;
          const candidates = execFileSync(shell, ['-c', probe], {
            env: sandbox.env,
            cwd: sandbox.cwd,
            timeout: 5000,
            maxBuffer: 1024 * 1024,
            encoding: 'utf8',
          })
            .trim()
            .split('\n');
          expect(candidates).toContain('--identity');
          expect(candidates).toContain('--json');
          expect(candidates).not.toContain('--after');
          expect(candidates).not.toContain('--limit');
          expect(candidates).not.toContain('--force');
        }
      }
    });
  });
  it('prints version and grammar-backed help without bootstrapping storage', async () => {
    await withSandbox(async (sandbox) => {
      const before = fileSnapshot(sandbox.root);
      const version = await runCli(sandbox, ['--version']);
      expect(version.status).toBe(0);
      expect(version.stdout).toBe('5.0.0-alpha.1\n');
      expect(version.stderr).toBe('');
      const help = await runCli(sandbox, ['help']);
      expect(help.status).toBe(0);
      expect(help.stderr).toBe('');
      expect(help.stdout).toContain('Native development preview');
      expect(help.stdout).toContain(
        'configuration, identity create/show/list, talk/reply/result, pane identity name/this/add/whoami/unbind/rm/list, diagnostic check/read, role/preamble, x attention, init, learn, and skill installation are available'
      );
      expect(help.stdout).toContain('Managed native upgrade/update is supported');
      expect(help.stdout).toContain('Manage identity records without probing tmux');
      expect(help.stdout).toContain('temporary unless saved');
      expect(help.stdout).toContain('rm');
      expect(help.stdout).toContain('remove role/preamble');
      expect(help.stdout).toContain('keep pane/exchanges');
      expect(help.stdout).not.toContain('--wait');
      expect(fileSnapshot(sandbox.root)).toEqual(before);
    });
  });

  it('rejects unmanaged upgrades before effects and supports structured alias failures', async () => {
    await withSandbox(async (sandbox) => {
      const before = fileSnapshot(sandbox.root);
      const result = await runCli(sandbox, ['upgrade']);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('not a managed native installation');
      const alias = await runCli(sandbox, ['update', '--json']);
      expect(alias.status).toBe(1);
      expectError(alias, 'NATIVE_UPGRADE_FAILED');
      expect(alias.stderr).toBe('');
      expect(fileSnapshot(sandbox.root)).toEqual(before);
      expect(existsSync(sandbox.database)).toBe(false);
    });
  });

  it('keeps diagnostic mode out of literal values and honors later real flags', async () => {
    await withSandbox(async (sandbox) => {
      const before = fileSnapshot(sandbox.root);
      for (const args of [
        ['role', 'set', 'body', '--file=--json'],
        ['list', '--', '--json', 'extra'],
        ['learn', '--config', '--json'],
      ]) {
        const result = await runCli(sandbox, args);
        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).not.toBe('');
      }
      for (const args of [
        ['list', '--identity', 'caller', '--json'],
        ['--identity', 'caller', 'talk', 'peer', 'hello', '--json'],
        ['name', '--json'],
        ['talk', 'peer', '--identity', '--json', 'hello'],
        ['talk', 'peer', '--identity', '--json', 'hello', '--nope'],
        ['no-command', 'talk', 'peer', '--identity', '--json', '--nope'],
      ]) {
        const result = await runCli(sandbox, args);
        expect(result.status).toBe(1);
        expectError(result, 'USAGE_ERROR');
      }
      expect(fileSnapshot(sandbox.root)).toEqual(before);
    });
  });

  it('runs the selected native executable from a path containing spaces and quotes', async () => {
    await withSandbox(async (sandbox) => {
      expect(sandbox.cli.args).toEqual([]);
      const directory = path.join(sandbox.root, "native build's files");
      mkdirSync(directory);
      const executable = path.join(directory, 'tmt preview');
      copyFileSync(sandbox.cli.executable, executable);
      const result = await runCli({ ...sandbox, cli: { executable, args: [] } }, ['--version']);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('5.0.0-alpha.1\n');
      expect(result.stderr).toBe('');
      expect(existsSync(sandbox.database)).toBe(false);
    });
  });
});
