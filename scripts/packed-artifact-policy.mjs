import fs from 'node:fs';
import path from 'node:path';

/**
 * Release smoke paths that must remain available to a packed installation.
 * This list is intentionally limited to the CLI/storage boundary and the
 * bundled skill sources; it is not a second registry of provider projections.
 */
export const REQUIRED_PACKED_PATHS = Object.freeze([
  'bin/tmux-team',
  'src/cli.ts',
  'src/cli-runner.ts',
  'src/cli/application.ts',
  'src/cli/parser.ts',
  'src/context.ts',
  'src/commands/role.ts',
  'src/role-service.ts',
  'src/storage/migrations.ts',
  'src/storage/sqlite-adapter.ts',
  'src/storage/identity-repository.ts',
  'src/storage/request-repository.ts',
  'skills/tmux-team/SKILL.md',
  'skills/codex/SKILL.md',
  'skills/claude/team.md',
]);

function relativePath(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

function findForbiddenSource(root) {
  const sourceRoot = path.join(root, 'src');
  if (!fs.existsSync(sourceRoot)) return null;
  const visit = (directory) => {
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const relative = relativePath(root, target);
      if (relative === 'src/test-support' || relative.startsWith('src/test-support/')) {
        if (!entry.isDirectory()) return relative;
        const nested = visit(target);
        return nested ?? relative;
      }
      if (entry.isFile() && entry.name.endsWith('.test.ts')) return relative;
      if (entry.isDirectory()) {
        const nested = visit(target);
        if (nested) return nested;
      }
    }
    return null;
  };
  return visit(sourceRoot);
}

/**
 * Validate the contents of an installed package, not the source checkout.
 * The verifier owns process-level installation and runtime checks; this helper
 * only enforces the package boundary and reports the first offending path.
 */
export function verifyPackedArtifact(packageRoot) {
  const root = path.resolve(packageRoot);
  for (const relative of REQUIRED_PACKED_PATHS) {
    const target = path.join(root, relative);
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      throw new Error(`Packed artifact is missing required file: ${relative}`);
    }
    if (!stat.isFile()) {
      throw new Error(`Packed artifact required path is not a file: ${relative}`);
    }
  }

  const forbidden = findForbiddenSource(root);
  if (forbidden) {
    throw new Error(`Packed artifact contains forbidden test-only path: ${forbidden}`);
  }

  return { checked: REQUIRED_PACKED_PATHS.length };
}
