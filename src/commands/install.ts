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
  getLegacyClaudeCommand,
  getLegacyCodexDirectories,
  getAgyConfigDirectory,
  getOpenCodeConfigDirectory,
  getPiCodingAgentDirectory,
  getSharedAgentDirectory,
  getSkillConfigs,
  getUniversalSkillConfig,
  hasBundledSkillSource,
  isSkillAgent,
  isCorrectLink,
  packageRoot,
  ALL_SKILL_TARGET,
  SKILL_AGENTS,
  targetExists,
} from '../skill-installation.js';
import type { SkillAgent, SkillConfig } from '../skill-installation.js';

export type InstallTarget = SkillAgent | typeof ALL_SKILL_TARGET;

interface InstallResult {
  agent?: SkillAgent;
  target: string;
  changed: boolean;
  backup?: string;
  legacyBackups?: string[];
}

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

function environmentDetected(agent: SkillAgent, home: string): boolean {
  switch (agent) {
    case 'claude':
      return fs.existsSync(path.join(home, '.claude')) || commandExists('claude');
    case 'codex': {
      const codexHome = getCodexHome(home);
      return (
        fs.existsSync(path.join(home, '.codex')) ||
        (path.resolve(codexHome) !== path.resolve(getSharedAgentDirectory(home)) &&
          fs.existsSync(codexHome)) ||
        commandExists('codex')
      );
    }
    case 'gemini':
      return fs.existsSync(path.join(home, '.gemini')) || commandExists('gemini');
    case 'agy':
      return fs.existsSync(getAgyConfigDirectory(home)) || commandExists('agy');
    case 'pi':
      return fs.existsSync(getPiCodingAgentDirectory(home)) || commandExists('pi');
    case 'opencode':
      return fs.existsSync(getOpenCodeConfigDirectory(home)) || commandExists('opencode');
  }
}

/** Detect installed agent environments without prompting the user. */
export function detectEnvironment(): SkillAgent[] {
  const home = os.homedir();
  return SKILL_AGENTS.filter((agent) => environmentDetected(agent, home));
}

function backupLegacyPath(ctx: Context, target: string, warning: string): string | undefined {
  if (!targetExists(target)) return undefined;
  if (!ctx.flags.force) {
    ctx.ui.warn(warning);
    return undefined;
  }
  const backup = backupPath(target);
  fs.renameSync(target, backup);
  return backup;
}

/** Migrate pre-4.3 copied Codex skills without deleting user data. */
export function migrateLegacyCodex(ctx: Context): string[] {
  const home = os.homedir();
  const codexHome = getCodexHome(home);
  const backups: string[] = [];
  for (const legacy of getLegacyCodexDirectories(home, codexHome)) {
    const backup = backupLegacyPath(
      ctx,
      legacy,
      `Legacy Codex skill found at ${legacy}; keeping it. Run "tmt install codex --force" to back it up and migrate.`
    );
    if (backup) backups.push(backup);
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
  let legacyBackups: string[] = [];
  if (agent === 'codex') {
    legacyBackups = migrateLegacyCodex(ctx);
  } else if (agent === 'claude') {
    const legacy = getLegacyClaudeCommand(os.homedir());
    const backup = backupLegacyPath(
      ctx,
      legacy,
      `Legacy Claude command found at ${legacy}; keeping it. Run "tmt install claude --force" to back it up and migrate.`
    );
    if (backup) legacyBackups = [backup];
  }
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

function installUniversal(ctx: Context): InstallResult {
  return installSelectedSkill(ctx, getUniversalSkillConfig());
}

function printNextSteps(ctx: Context, installed: InstallResult[]): void {
  if (ctx.flags.json) {
    ctx.ui.json({ installed });
    return;
  }
  const seenTargets = new Set<string>();
  for (const item of installed) {
    const shared = seenTargets.has(item.target);
    const label = item.agent === undefined ? 'skill' : `${item.agent} skill`;
    ctx.ui.success(
      shared
        ? `${item.agent ? `${item.agent} integration` : 'Skill'} uses the shared skill at ${item.target}`
        : `${label} linked at ${item.target}`
    );
    seenTargets.add(item.target);
    if (item.backup) ctx.ui.info(`Previous path moved to recoverable backup: ${item.backup}`);
    for (const backup of item.legacyBackups ?? []) {
      const legacyLabel = item.agent === 'claude' ? 'Legacy Claude command' : 'Legacy Codex skill';
      ctx.ui.info(`${legacyLabel} moved to recoverable backup: ${backup}`);
    }
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
  const requested = agent?.toLowerCase();
  const requestedAgent = requested && isSkillAgent(requested) ? requested : undefined;
  if (requested && requested !== ALL_SKILL_TARGET && requestedAgent === undefined) {
    ctx.ui.error(`Unknown agent: ${agent}`);
    ctx.ui.info(`Supported agents: ${[...SKILL_AGENTS, ALL_SKILL_TARGET].join(', ')}`);
    ctx.exit(ExitCodes.ERROR);
  }

  const installed: InstallResult[] = [];
  try {
    if (directory !== undefined) {
      installed.push(installCustom(ctx, directory));
    } else {
      let agents: SkillAgent[];
      if (requested === ALL_SKILL_TARGET) agents = [...SKILL_AGENTS];
      else if (requestedAgent) agents = [requestedAgent];
      else {
        agents = detectEnvironment();
      }
      // A clean machine gets the universal Open Agent Skill without inventing
      // a provider identity in the structured result.
      if (agents.length === 0) {
        installed.push(installUniversal(ctx));
      } else {
        for (const selected of agents) {
          installed.push(installAgent(ctx, selected));
        }
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
