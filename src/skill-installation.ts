import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Ordered provider inventory shared by skill installation and completion. */
export const SKILL_AGENTS = Object.freeze(['claude', 'codex', 'gemini'] as const);
export type SkillAgent = (typeof SKILL_AGENTS)[number];
export const ALL_SKILL_TARGET = 'all' as const;

export function isSkillAgent(value: string): value is SkillAgent {
  return (SKILL_AGENTS as readonly string[]).includes(value);
}

export interface SkillConfig {
  readonly source: string;
  readonly target: string;
}

/** Resolve the package root containing the bundled skill sources. */
export function packageRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  let directory = path.dirname(currentFile);
  for (let index = 0; index < 6; index += 1) {
    if (fs.existsSync(path.join(directory, 'package.json'))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return path.resolve(path.dirname(currentFile), '..');
}

export function getCodexHome(home = os.homedir()): string {
  return process.env.CODEX_HOME || path.join(home, '.codex');
}

export function getUniversalSkillSource(root = packageRoot()): string {
  return path.join(root, 'skills', 'tmux-team');
}

export function getUniversalSkillFile(root = packageRoot()): string {
  return path.join(getUniversalSkillSource(root), 'SKILL.md');
}

export function hasBundledSkillSource(source: string): boolean {
  try {
    const stat = fs.statSync(source);
    return (
      stat.isFile() || (stat.isDirectory() && fs.statSync(path.join(source, 'SKILL.md')).isFile())
    );
  } catch {
    return false;
  }
}

function getManagedSkillTarget(home: string): string {
  return path.join(home, '.agents', 'skills', 'tmux-team');
}

export function getLegacyCodexDirectories(home: string, codexHome: string): string[] {
  const managedTarget = path.resolve(getManagedSkillTarget(home));
  const candidates = [
    path.join(codexHome, 'skills', 'tmux-team'),
    path.join(home, '.codex', 'skills', 'tmux-team'),
  ];
  return candidates.filter(
    (candidate, index) =>
      path.resolve(candidate) !== managedTarget &&
      candidates.findIndex((other) => path.resolve(other) === path.resolve(candidate)) === index
  );
}

export function getSkillConfigs(
  root = packageRoot(),
  home = os.homedir()
): Record<SkillAgent, SkillConfig> {
  const universal = getUniversalSkillSource(root);
  const agentTarget = getManagedSkillTarget(home);
  return {
    claude: {
      source: path.join(root, 'skills', 'claude', 'team.md'),
      target: path.join(home, '.claude', 'commands', 'team.md'),
    },
    // Codex and Gemini intentionally share one official user-global location.
    codex: { source: universal, target: agentTarget },
    gemini: { source: universal, target: agentTarget },
  };
}

export function getCustomSkillConfig(root: string, directory: string): SkillConfig {
  return {
    source: getUniversalSkillSource(root),
    target: path.join(path.resolve(directory), 'tmux-team'),
  };
}

export function targetExists(target: string): boolean {
  // existsSync is false for broken links; lstat is needed so --force can back them up.
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

export function isCorrectLink(target: string, source: string): boolean {
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isSymbolicLink()) return false;
    return path.resolve(path.dirname(target), fs.readlinkSync(target)) === path.resolve(source);
  } catch {
    return false;
  }
}

export function backupPath(target: string): string {
  const base = `${target}.backup-${Date.now()}`;
  let candidate = base;
  let suffix = 1;
  while (targetExists(candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}

function resolvedPathForComparison(value: string): string {
  const absolute = path.resolve(value);
  let current = absolute;
  const suffix: string[] = [];
  while (true) {
    try {
      const resolved = fs.realpathSync(current);
      return path.join(resolved, ...suffix);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function containsPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  const traversesParent = relative === '..' || relative.startsWith(`..${path.sep}`);
  return relative === '' || (!traversesParent && !path.isAbsolute(relative));
}

/** Reject a target that could rename or overwrite any part of its bundled source. */
export function assertSafeSkillTarget(source: string, target: string): void {
  const resolvedSource = resolvedPathForComparison(source);
  const resolvedTarget = resolvedPathForComparison(target);
  if (
    containsPath(resolvedSource, resolvedTarget) ||
    containsPath(resolvedTarget, resolvedSource)
  ) {
    throw new Error(`Skill target overlaps bundled source: ${target}`);
  }
}

/** Create a managed symlink, preserving an unmanaged target when forced. */
export function ensureManagedLink(
  target: string,
  source: string,
  force = false
): string | undefined {
  if (isCorrectLink(target, source)) return undefined;
  let backup: string | undefined;
  if (targetExists(target)) {
    if (!force) {
      throw new Error(`Refusing to replace existing unmanaged path: ${target} (use --force)`);
    }
    backup = backupPath(target);
    fs.renameSync(target, backup);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Omitting the platform-specific type keeps this portable on Darwin and Linux.
  fs.symlinkSync(source, target);
  return backup;
}
