import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ciGatePasses, readChangedCiAreas, selectCiAreas } from '../../scripts/ci-scope.mjs';

const { runPackedCommand } = await import(
  new URL('../../scripts/packed-command.mjs', import.meta.url).href
);

describe('CI area selection', () => {
  it('selects Office without the native matrix for app-only changes', () => {
    expect(selectCiAreas(['apps/office/src/main.tsx', 'docs/office/architecture.md'])).toEqual({
      native: false,
      office: true,
    });
  });

  it('selects native code and embedded skill consumers without Office', () => {
    expect(selectCiAreas(['rust/crates/tmt-core/src/lib.rs', 'skills/tmux-team/SKILL.md'])).toEqual(
      { native: true, office: false }
    );
  });

  it.each([
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'package.json',
    '.github/workflows/ci.yml',
    'scripts/ci-scope.mjs',
    'test/e2e/Dockerfile',
    'contracts/office/request.json',
    'services/office/firestore.rules',
    'new-owner/file.ts',
  ])('fans out shared or unknown input %s', (file) => {
    expect(selectCiAreas([file])).toEqual({ native: true, office: true });
  });

  it('does not confuse similar prefixes and fails closed on an empty diff', () => {
    expect(selectCiAreas(['apps/office-other/file.ts'])).toEqual({ native: true, office: true });
    expect(selectCiAreas([])).toEqual({ native: true, office: true });
  });

  it('unions mixed paths including both sides of a no-renames diff', () => {
    expect(selectCiAreas(['apps/office/removed.ts', 'rust/new.rs'])).toEqual({
      native: true,
      office: true,
    });
    expect(selectCiAreas(['apps/office/deleted.ts'])).toEqual({ native: false, office: true });
  });
});

describe('CI diff and command integration', () => {
  it('reads actual additions, cross-owner renames and deletions with whitespace-safe paths', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tmt-ci-scope-'));
    const git = (args: string[]): string =>
      runPackedCommand('git', args, {
        cwd: root,
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      });
    const commit = (): string => {
      git(['add', '.']);
      git([
        '-c',
        'user.name=TMT Test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '-m',
        'Test fixture\n\nCo-authored-by: Codex <codex@openai.com>',
      ]);
      return git(['rev-parse', 'HEAD']).trim();
    };
    try {
      git(['init', '--quiet']);
      writeFileSync(path.join(root, 'README.md'), 'fixture\n');
      const base = commit();
      mkdirSync(path.join(root, 'apps/office'), { recursive: true });
      const source = path.join(root, 'apps/office/name with\nnewline.ts');
      writeFileSync(source, 'export const fixture = true;\n');
      const added = commit();
      expect(readChangedCiAreas(base, added, root)).toEqual({ native: false, office: true });
      mkdirSync(path.join(root, 'rust'));
      const target = path.join(root, 'rust/fixture.rs');
      renameSync(source, target);
      const moved = commit();
      expect(readChangedCiAreas(added, moved, root)).toEqual({ native: true, office: true });
      rmSync(target);
      const deleted = commit();
      expect(readChangedCiAreas(moved, deleted, root)).toEqual({ native: true, office: false });
      expect(() => readChangedCiAreas('--help', deleted, root)).toThrow('exact base and head');
      expect(() => readChangedCiAreas('0'.repeat(40), deleted, root)).toThrow(
        'Packed command failed'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 5000);

  it('propagates gate failure to the command exit instead of only returning a boolean', () => {
    const script = fileURLToPath(new URL('../../scripts/ci-scope.mjs', import.meta.url));
    const options = { cwd: tmpdir(), env: process.env };
    expect(runPackedCommand(process.execPath, [script, 'gate', 'true', 'success'], options)).toBe(
      ''
    );
    expect(() =>
      runPackedCommand(process.execPath, [script, 'gate', 'true', 'skipped'], options)
    ).toThrow('Selected CI work did not complete successfully');
  });
});

describe('required CI gate', () => {
  it('accepts only successful selected work or explicitly unselected skipped work', () => {
    expect(ciGatePasses('true', ['success', 'success'])).toBe(true);
    expect(ciGatePasses('false', ['skipped', 'skipped'])).toBe(true);
  });

  it.each(['failure', 'cancelled', 'skipped', '', 'unknown'])(
    'rejects selected result %s',
    (result) => {
      expect(ciGatePasses('true', ['success', result])).toBe(false);
    }
  );

  it('rejects missing selection/results and contradictions rather than claiming a pass', () => {
    expect(ciGatePasses('', ['skipped'])).toBe(false);
    expect(ciGatePasses('true', [])).toBe(false);
    expect(ciGatePasses('false', ['success'])).toBe(false);
    expect(ciGatePasses('false', ['failure'])).toBe(false);
  });
});
