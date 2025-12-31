import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('bin/tmux-team wrapper', () => {
  it('runs from a non-project cwd with hoisted tsx', () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
    const tempRoot = mkdtempSync(join(repoRoot, '.tmp-bin-wrapper-'));

    try {
      const projectRoot = join(tempRoot, 'project');
      const userCwd = join(tempRoot, 'cwd');

      const installedPkgRoot = join(projectRoot, 'node_modules', 'tmux-team');
      const installedBin = join(installedPkgRoot, 'bin', 'tmux-team');
      const installedCli = join(installedPkgRoot, 'src', 'cli.ts');

      mkdirSync(join(installedPkgRoot, 'bin'), { recursive: true });
      mkdirSync(join(installedPkgRoot, 'src'), { recursive: true });
      mkdirSync(join(projectRoot, 'node_modules'), { recursive: true });
      mkdirSync(userCwd, { recursive: true });

      // Ensure Node treats the extensionless bin file as ESM (like a real install).
      writeFileSync(
        join(installedPkgRoot, 'package.json'),
        JSON.stringify({ name: 'tmux-team', version: '0.0.0-test', type: 'module' })
      );

      copyFileSync(join(repoRoot, 'bin', 'tmux-team'), installedBin);
      writeFileSync(installedCli, 'process.exit(0);\n');

      // Simulate hoisting: tsx is present at the project root, not inside tmux-team/node_modules.
      const require = createRequire(import.meta.url);
      const tsxDir = dirname(require.resolve('tsx/package.json'));
      symlinkSync(tsxDir, join(projectRoot, 'node_modules', 'tsx'), 'dir');

      const result = spawnSync(process.execPath, [installedBin, '--help'], {
        cwd: userCwd,
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
