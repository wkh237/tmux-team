// ─────────────────────────────────────────────────────────────
// install command - install tmux-team skills for AI agents
// ─────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '../types.js';
import { ExitCodes } from '../exits.js';
import { colors } from '../ui.js';
import {
  backupPath,
  assertSafeSkillTarget,
  ensureManagedLink,
  getCodexHome,
  getCustomSkillConfig,
  getLegacyCodexDirectories,
  getSkillConfigs,
  hasBundledSkillSource,
  isCorrectLink,
  packageRoot,
  targetExists,
} from '../skill-installation.js';
import type { SkillAgent, SkillConfig } from '../skill-installation.js';

export type InstallTarget = SkillAgent | 'all';

interface InstallResult {
  agent?: SkillAgent;
  target: string;
  changed: boolean;
  backup?: string;
  legacyBackups?: string[];
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
export function detectEnvironment(): SkillAgent[] {
  const home = os.homedir();
  const detected: SkillAgent[] = [];
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

/** Migrate pre-4.3 copied Codex skills without deleting user data. */
export function migrateLegacyCodex(ctx: Context): string[] {
  const home = os.homedir();
  const codexHome = getCodexHome(home);
  const backups: string[] = [];
  for (const legacy of getLegacyCodexDirectories(home, codexHome)) {
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

function installSelectedSkill(ctx: Context, selected: SkillConfig): Omit<InstallResult, 'agent'> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error('Skill installation is supported on Darwin and Linux only.');
  }
  if (!hasBundledSkillSource(selected.source))
    throw new Error(`Bundled skill source not found: ${selected.source}`);
  const wasCorrect = isCorrectLink(selected.target, selected.source);
  if (!wasCorrect) assertSafeSkillTarget(selected.source, selected.target);
  const backup = ensureManagedLink(selected.target, selected.source, ctx.flags.force);
  return {
    target: selected.target,
    changed: !wasCorrect,
    ...(backup ? { backup } : {}),
  };
}

function installAgent(ctx: Context, agent: SkillAgent): InstallResult {
  const base = installSelectedSkill(ctx, getSkillConfigs()[agent]);
  const legacyBackups = agent === 'codex' ? migrateLegacyCodex(ctx) : [];
  return {
    agent,
    ...base,
    ...(legacyBackups.length > 0 ? { legacyBackups } : {}),
  };
}

function installCustom(ctx: Context, directory: string): InstallResult {
  const selected = getCustomSkillConfig(packageRoot(), directory);
  return installSelectedSkill(ctx, selected);
}

function printNextSteps(ctx: Context, installed: InstallResult[]): void {
  if (ctx.flags.json) {
    ctx.ui.json({ installed });
    return;
  }
  const seenTargets = new Set<string>();
  for (const item of installed) {
    const shared = seenTargets.has(item.target);
    const label = item.agent === undefined ? 'custom skill' : `${item.agent} skill`;
    ctx.ui.success(
      shared
        ? `${item.agent} integration uses the shared skill at ${item.target}`
        : `${label} linked at ${item.target}`
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
  console.log(`  ${colors.cyan('tmt talk <target> "message" --timeout 180')}`);
  console.log(`  ${colors.cyan('tmt result <request-id> --json')} (after timeout or --detach)`);
}

export async function cmdInstall(ctx: Context, agent?: string, directory?: string): Promise<void> {
  if (directory !== undefined) {
    if (agent !== undefined) {
      ctx.ui.error('The --dir option cannot be combined with an agent or all.');
      ctx.exit(ExitCodes.ERROR);
    }
    if (directory.trim() === '') {
      ctx.ui.error('Install directory must not be empty.');
      ctx.exit(ExitCodes.ERROR);
    }
  }
  const requested = agent?.toLowerCase() as InstallTarget | undefined;
  if (requested && !SUPPORTED_AGENTS.includes(requested)) {
    ctx.ui.error(`Unknown agent: ${agent}`);
    ctx.ui.info(`Supported agents: ${SUPPORTED_AGENTS.join(', ')}`);
    ctx.exit(ExitCodes.ERROR);
  }

  const installed: InstallResult[] = [];
  try {
    if (directory !== undefined) {
      installed.push(installCustom(ctx, directory));
    } else {
      let agents: SkillAgent[];
      if (requested === 'all') agents = ['claude', 'codex', 'gemini'];
      else if (requested) agents = [requested];
      else {
        agents = detectEnvironment();
        // A clean machine gets the universal Open Agent Skill.
        if (agents.length === 0) agents = ['codex'];
      }
      for (const selected of agents) {
        installed.push(installAgent(ctx, selected));
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Refusing to replace existing unmanaged path')) ctx.ui.warn(message);
    else ctx.ui.error(message);
    ctx.exit(ExitCodes.ERROR);
  }
  printNextSteps(ctx, installed);
}
