// ─────────────────────────────────────────────────────────────
// install-skill command - install tmux-team skills for AI agents
// ─────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Context } from '../types.js';
import { ExitCodes } from '../context.js';

type AgentType = 'claude' | 'codex';
type Scope = 'user' | 'local';

interface SkillConfig {
  sourceFile: string;
  userDir: string;
  localDir: string;
  targetFile: string;
}

function getCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

const SKILL_CONFIGS: Record<AgentType, SkillConfig> = {
  claude: {
    sourceFile: 'skills/claude/team.md',
    userDir: path.join(os.homedir(), '.claude', 'commands'),
    localDir: '.claude/commands',
    targetFile: 'team.md',
  },
  codex: {
    sourceFile: 'skills/codex/SKILL.md',
    userDir: path.join(getCodexHome(), 'skills', 'tmux-team'),
    localDir: '.codex/skills/tmux-team',
    targetFile: 'SKILL.md',
  },
};

const SUPPORTED_AGENTS = Object.keys(SKILL_CONFIGS) as AgentType[];

function findPackageRoot(): string {
  // Get current file's directory (ES modules don't have __dirname)
  const currentFile = fileURLToPath(import.meta.url);
  let dir = path.dirname(currentFile);

  // Try to find the package root by looking for package.json
  for (let i = 0; i < 5; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: assume we're in src/commands
  return path.resolve(path.dirname(currentFile), '..', '..');
}

function exitWithError(ctx: Context, error: string, hint?: string): never {
  if (ctx.flags.json) {
    ctx.ui.json({ success: false, error, hint });
  } else {
    ctx.ui.error(error);
    if (hint) ctx.ui.info(hint);
  }
  ctx.exit(ExitCodes.ERROR);
}

export function cmdInstallSkill(ctx: Context, agent?: string, scope: string = 'user'): void {
  // Validate agent
  if (!agent) {
    exitWithError(
      ctx,
      'Usage: tmux-team install-skill <agent> [--local|--user]',
      `Supported agents: ${SUPPORTED_AGENTS.join(', ')}`
    );
  }

  const agentLower = agent.toLowerCase() as AgentType;
  if (!SUPPORTED_AGENTS.includes(agentLower)) {
    exitWithError(
      ctx,
      `Unknown agent: ${agent}`,
      `Supported agents: ${SUPPORTED_AGENTS.join(', ')}`
    );
  }

  // Validate scope
  const scopeLower = scope.toLowerCase() as Scope;
  if (scopeLower !== 'user' && scopeLower !== 'local') {
    exitWithError(ctx, `Invalid scope: ${scope}. Use 'user' or 'local'.`);
  }

  const config = SKILL_CONFIGS[agentLower];
  const pkgRoot = findPackageRoot();
  const sourcePath = path.join(pkgRoot, config.sourceFile);

  // Check source file exists
  if (!fs.existsSync(sourcePath)) {
    exitWithError(
      ctx,
      `Skill file not found: ${sourcePath}`,
      'Make sure tmux-team is properly installed.'
    );
  }

  // Determine target directory
  const targetDir = scopeLower === 'user' ? config.userDir : path.resolve(config.localDir);
  const targetPath = path.join(targetDir, config.targetFile);

  // Check if already exists
  if (fs.existsSync(targetPath) && !ctx.flags.force) {
    exitWithError(ctx, `Skill already exists: ${targetPath}`, 'Use --force to overwrite.');
  }

  // Create directory if needed
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
    if (ctx.flags.verbose) {
      ctx.ui.info(`Created directory: ${targetDir}`);
    }
  }

  // Copy file
  fs.copyFileSync(sourcePath, targetPath);

  if (ctx.flags.json) {
    ctx.ui.json({
      success: true,
      agent: agentLower,
      scope: scopeLower,
      path: targetPath,
    });
  } else {
    ctx.ui.success(`Installed ${agentLower} skill to ${targetPath}`);

    // Show usage hint
    if (agentLower === 'claude') {
      ctx.ui.info('Usage: /team talk codex "message"');
    } else if (agentLower === 'codex') {
      ctx.ui.info('Enable skills: codex --enable skills');
      ctx.ui.info('Usage: $tmux-team or implicit invocation');
    }
  }
}
