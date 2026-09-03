// ─────────────────────────────────────────────────────────────
// install command - install tmux-team skills for AI agents
// ─────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '../types.js';
import { ExitCodes } from '../exits.js';
import { colors } from '../ui.js';

export type AgentType = 'claude' | 'codex' | 'gemini';
export type InstallTarget = AgentType | 'all';

interface InstallResult {
  agent: AgentType;
  target: string;
  changed: boolean;
  backup?: string;
  legacyBackups?: string[];
}

interface SkillConfig {
  source: string;
  target: string;
}

export function getCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function packageRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  let dir = path.dirname(currentFile);
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(path.dirname(currentFile), '..', '..');
}

export function getSkillConfigs(root = packageRoot()): Record<AgentType, SkillConfig> {
  const home = os.homedir();
  const universal = path.join(root, 'skills', 'tmux-team');
  return {
    claude: {
      source: path.join(root, 'skills', 'claude', 'team.md'),
      target: path.join(home, '.claude', 'commands', 'team.md'),
    },
    // Codex and Gemini intentionally share one official user-global location.
    codex: { source: universal, target: path.join(home, '.agents', 'skills', 'tmux-team') },
    gemini: { source: universal, target: path.join(home, '.agents', 'skills', 'tmux-team') },
  };
}

const SUPPORTED_AGENTS: InstallTarget[] = ['claude', 'codex', 'gemini', 'all'];

function commandExists(command: string): boolean {
  const searchPath = process.env.PATH ?? '';
  return searchPath.split(path.delimiter).some((dir) => {
    try {
      return fs.statSync(path.join(dir, command)).isFile();
    } catch {
      return false;
    }
  });
}

/** Detect installed agent environments without prompting the user. */
export function detectEnvironment(): AgentType[] {
  const home = os.homedir();
  const detected: AgentType[] = [];
  if (fs.existsSync(path.join(home, '.claude')) || commandExists('claude')) detected.push('claude');
  if (
    fs.existsSync(path.join(home, '.agents')) ||
    fs.existsSync(path.join(home, '.codex')) ||
    fs.existsSync(getCodexHome()) ||
    commandExists('codex')
  ) {
    detected.push('codex');
  }
  if (fs.existsSync(path.join(home, '.gemini')) || commandExists('gemini')) detected.push('gemini');
  return detected;
}

function targetExists(target: string): boolean {
  // existsSync is false for broken links; lstat is needed so --force can back them up.
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function isCorrectLink(target: string, source: string): boolean {
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isSymbolicLink()) return false;
    return path.resolve(path.dirname(target), fs.readlinkSync(target)) === path.resolve(source);
  } catch {
    return false;
  }
}

function backupPath(target: string): string {
  const base = `${target}.backup-${Date.now()}`;
  let candidate = base;
  let suffix = 1;
  while (targetExists(candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}

function legacyCodexDirectories(): string[] {
  const home = os.homedir();
  const candidates = [
    path.join(getCodexHome(), 'skills', 'tmux-team'),
    path.join(home, '.codex', 'skills', 'tmux-team'),
  ];
  const managedTarget = path.resolve(getSkillConfigs().codex.target);
  return candidates.filter(
    (candidate, index) =>
      path.resolve(candidate) !== managedTarget &&
      candidates.findIndex((other) => path.resolve(other) === path.resolve(candidate)) === index
  );
}

/** Migrate pre-4.3 copied Codex skills without deleting user data. */
export function migrateLegacyCodex(ctx: Context): string[] {
  const backups: string[] = [];
  for (const legacy of legacyCodexDirectories()) {
    if (!targetExists(legacy)) continue;
    if (!ctx.flags.force) {
      ctx.ui.warn(
        `Legacy Codex skill found at ${legacy}; keeping it. Run "tmt install codex --force" to back it up and migrate.`
      );
      continue;
    }
    const backup = backupPath(legacy);
    fs.renameSync(legacy, backup);
    backups.push(backup);
  }
  return backups;
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

function installAgent(ctx: Context, agent: AgentType): InstallResult {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error('Skill installation is supported on Darwin and Linux only.');
  }
  const selected = getSkillConfigs()[agent];
  if (!fs.existsSync(selected.source))
    throw new Error(`Bundled skill source not found: ${selected.source}`);
  const wasCorrect = isCorrectLink(selected.target, selected.source);
  const backup = ensureManagedLink(selected.target, selected.source, ctx.flags.force);
  const legacyBackups = agent === 'codex' ? migrateLegacyCodex(ctx) : [];
  return {
    agent,
    target: selected.target,
    changed: !wasCorrect,
    ...(backup ? { backup } : {}),
    ...(legacyBackups.length > 0 ? { legacyBackups } : {}),
  };
}

function printNextSteps(ctx: Context, installed: InstallResult[]): void {
  if (ctx.flags.json) {
    ctx.ui.json({ installed });
    return;
  }
  const seenTargets = new Set<string>();
  for (const item of installed) {
    const shared = seenTargets.has(item.target);
    ctx.ui.success(
      shared
        ? `${item.agent} integration uses the shared skill at ${item.target}`
        : `${item.agent} skill linked at ${item.target}`
    );
    seenTargets.add(item.target);
    if (item.backup) ctx.ui.info(`Previous path moved to recoverable backup: ${item.backup}`);
    for (const backup of item.legacyBackups ?? []) {
      ctx.ui.info(`Legacy Codex skill moved to recoverable backup: ${backup}`);
    }
  }
  if (installed.some((item) => item.agent === 'claude')) {
    console.log(colors.yellow('Claude Code full plugin (optional):'));
    console.log(`  ${colors.cyan('/plugin marketplace add wkh237/tmux-team')}`);
    console.log(`  ${colors.cyan('/plugin install tmux-team@tmux-team')}`);
  }
  console.log(colors.yellow('Next steps:'));
  console.log(
    `  ${colors.cyan('tmt add <pane-target> <global-name>')} or ${colors.cyan('tmt this <global-name>')}`
  );
  console.log(`  ${colors.cyan('tmt talk <target> "message" --wait')}`);
}

export async function cmdInstall(ctx: Context, agent?: string): Promise<void> {
  const requested = agent?.toLowerCase() as InstallTarget | undefined;
  if (requested && !SUPPORTED_AGENTS.includes(requested)) {
    ctx.ui.error(`Unknown agent: ${agent}`);
    ctx.ui.info(`Supported agents: ${SUPPORTED_AGENTS.join(', ')}`);
    ctx.exit(ExitCodes.ERROR);
  }

  let agents: AgentType[];
  if (requested === 'all') agents = ['claude', 'codex', 'gemini'];
  else if (requested) agents = [requested];
  else {
    agents = detectEnvironment();
    // A clean machine gets the universal Open Agent Skill.
    if (agents.length === 0) agents = ['codex'];
  }

  const installed: InstallResult[] = [];
  try {
    for (const selected of agents) {
      installed.push(installAgent(ctx, selected));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Refusing to replace existing unmanaged path')) ctx.ui.warn(message);
    else ctx.ui.error(message);
    ctx.exit(ExitCodes.ERROR);
  }
  printNextSteps(ctx, installed);
}
