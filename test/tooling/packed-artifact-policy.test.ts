import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { FORBIDDEN_PACKED_PATHS, REQUIRED_PACKED_PATHS, verifyPackedArtifact } = (await import(
  pathToFileURL(path.join(repositoryRoot, 'scripts', 'packed-artifact-policy.mjs')).href
)) as unknown as {
  FORBIDDEN_PACKED_PATHS: readonly string[];
  REQUIRED_PACKED_PATHS: readonly string[];
  verifyPackedArtifact: (packageRoot: string) => { checked: number };
};

function createPackageFixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tmt-packed-artifact-'));
  try {
    for (const relative of REQUIRED_PACKED_PATHS) {
      const target = path.join(root, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, `packed fixture: ${relative}\n`);
    }
    return root;
  } catch (error) {
    removePackageFixture(root);
    throw error;
  }
}

function removePackageFixture(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

describe('packed artifact policy', () => {
  it('accepts the release smoke runtime and intended skill files', () => {
    const root = createPackageFixture();
    try {
      expect(verifyPackedArtifact(root)).toEqual({ checked: REQUIRED_PACKED_PATHS.length });
    } finally {
      removePackageFixture(root);
    }
  });

  it.each(['src/storage/migrations.ts', 'skills/tmux-team/SKILL.md'])(
    'rejects a missing required path: %s',
    (relative) => {
      const root = createPackageFixture();
      try {
        unlinkSync(path.join(root, relative));
        expect(() => verifyPackedArtifact(root)).toThrow(new RegExp(relative));
      } finally {
        removePackageFixture(root);
      }
    }
  );

  it.each(['src/domain/nested.test.ts', 'src/test-support/workers/worker.ts'])(
    'rejects nested test-only content: %s',
    (relative) => {
      const root = createPackageFixture();
      try {
        const target = path.join(root, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, 'forbidden fixture\n');
        expect(() => verifyPackedArtifact(root)).toThrow(new RegExp(relative));
      } finally {
        removePackageFixture(root);
      }
    }
  );

  it.each(FORBIDDEN_PACKED_PATHS)('rejects retired packed asset: %s', (relative) => {
    const root = createPackageFixture();
    try {
      const target = path.join(root, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      if (path.extname(relative)) writeFileSync(target, 'retired fixture\n');
      else mkdirSync(target, { recursive: true });
      expect(() => verifyPackedArtifact(root)).toThrow(
        `Packed artifact contains retired skill asset: ${relative}`
      );
    } finally {
      removePackageFixture(root);
    }
  });

  it('cleans disposable fixtures after both success and failure', () => {
    const root = createPackageFixture();
    try {
      writeFileSync(path.join(root, 'src', 'worker.test.ts'), 'forbidden fixture\n');
      expect(() => verifyPackedArtifact(root)).toThrow(/src\/worker\.test\.ts/);
    } finally {
      removePackageFixture(root);
    }
    expect(existsSync(root)).toBe(false);
  });
});
