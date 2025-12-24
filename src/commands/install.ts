// ─────────────────────────────────────────────────────────────
// install command - install tmux-team for AI agents
// ─────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Context } from '../types.js';
import { ExitCodes } from '../exits.js';
import { colors } from '../ui.js';
import { cmdSetup } from './setup.js';

type AgentType = 'claude' | 'codex';

interface SkillConfig {
  sourceFile: string;
  userDir: string;
  targetFile: string;
  detected: () => boolean;
}

function getCodexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

const SKILL_CONFIGS: Record<AgentType, SkillConfig> = {
  claude: {
    sourceFile: 'skills/claude/team.md',
    userDir: path.join(os.homedir(), '.claude', 'commands'),
    targetFile: 'team.md',
    detected: () => fs.existsSync(path.join(os.homedir(), '.claude')),
  },
  codex: {
    sourceFile: 'skills/codex/SKILL.md',
    userDir: path.join(getCodexHome(), 'skills', 'tmux-team'),
    targetFile: 'SKILL.md',
    detected: () => fs.existsSync(getCodexHome()),
  },
};

const SUPPORTED_AGENTS = Object.keys(SKILL_CONFIGS) as AgentType[];

function findPackageRoot(): string {
  const currentFile = fileURLToPath(import.meta.url);
  let dir = path.dirname(currentFile);

  for (let i = 0; i < 5; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(path.dirname(currentFile), '..', '..');
}

function detectEnvironment(): AgentType[] {
  const detected: AgentType[] = [];
  for (const [agent, config] of Object.entries(SKILL_CONFIGS)) {
    if (config.detected()) {
      detected.push(agent as AgentType);
    }
  }
  return detected;
}

async function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function confirm(rl: readline.Interface, question: string): Promise<boolean> {
  const answer = await prompt(rl, `${question} [Y/n]: `);
  return answer.toLowerCase() !== 'n';
}

function installSkill(ctx: Context, agent: AgentType): boolean {
  const config = SKILL_CONFIGS[agent];
  const pkgRoot = findPackageRoot();
  const sourcePath = path.join(pkgRoot, config.sourceFile);

  if (!fs.existsSync(sourcePath)) {
    ctx.ui.error(`Skill file not found: ${sourcePath}`);
    ctx.ui.info('Make sure tmux-team is properly installed.');
    return false;
  }

  const targetPath = path.join(config.userDir, config.targetFile);

  if (fs.existsSync(targetPath) && !ctx.flags.force) {
    ctx.ui.warn(`Skill already exists: ${targetPath}`);
    ctx.ui.info('Use --force to overwrite.');
    return false;
  }

  if (!fs.existsSync(config.userDir)) {
    fs.mkdirSync(config.userDir, { recursive: true });
  }

  fs.copyFileSync(sourcePath, targetPath);
  return true;
}

export async function cmdInstall(ctx: Context, agent?: string): Promise<void> {
  const { ui, flags, exit } = ctx;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    let selectedAgent: AgentType;

    if (agent) {
      // Direct agent specification
      const agentLower = agent.toLowerCase() as AgentType;
      if (!SUPPORTED_AGENTS.includes(agentLower)) {
        ui.error(`Unknown agent: ${agent}`);
        ui.info(`Supported agents: ${SUPPORTED_AGENTS.join(', ')}`);
        exit(ExitCodes.ERROR);
      }
      selectedAgent = agentLower;
    } else {
      // Auto-detect and prompt
      const detected = detectEnvironment();
      console.log();

      if (detected.length === 0) {
        ui.info('No AI agent environments detected.');
        ui.info(`Supported agents: ${SUPPORTED_AGENTS.join(', ')}`);
        console.log();
        const choice = await prompt(rl, 'Which agent are you using? ');
        const choiceLower = choice.toLowerCase() as AgentType;
        if (!SUPPORTED_AGENTS.includes(choiceLower)) {
          ui.error(`Unknown agent: ${choice}`);
          exit(ExitCodes.ERROR);
        }
        selectedAgent = choiceLower;
      } else if (detected.length === 1) {
        ui.success(`Detected: ${detected[0]}`);
        selectedAgent = detected[0];
      } else {
        ui.info(`Detected multiple environments: ${detected.join(', ')}`);
        const choice = await prompt(rl, 'Which agent are you installing for? ');
        const choiceLower = choice.toLowerCase() as AgentType;
        if (!SUPPORTED_AGENTS.includes(choiceLower)) {
          ui.error(`Unknown agent: ${choice}`);
          exit(ExitCodes.ERROR);
        }
        selectedAgent = choiceLower;
      }
    }

    // Install the skill
    console.log();
    const success = installSkill(ctx, selectedAgent);
    if (!success) {
      exit(ExitCodes.ERROR);
    }

    const config = SKILL_CONFIGS[selectedAgent];
    const targetPath = path.join(config.userDir, config.targetFile);
    ui.success(`Installed ${selectedAgent} skill to ${targetPath}`);

    // Agent-specific instructions
    console.log();
    if (selectedAgent === 'claude') {
      console.log(colors.yellow('For full plugin features, run these in Claude Code:'));
      console.log(`  ${colors.cyan('/plugin marketplace add wkh237/tmux-team')}`);
      console.log(`  ${colors.cyan('/plugin install tmux-team')}`);
      console.log();
    } else if (selectedAgent === 'codex') {
      console.log(colors.yellow('Enable skills in Codex:'));
      console.log(`  ${colors.cyan('codex --enable skills')}`);
      console.log();
    }

    // Offer to run setup
    if (process.env.TMUX) {
      const runSetup = await confirm(rl, 'Run setup wizard now?');
      if (runSetup) {
        rl.close();
        await cmdSetup(ctx);
        return;
      }
    } else {
      ui.info('Run tmux-team setup inside tmux to configure your agents.');
    }

    console.log();
    console.log(colors.yellow('Next steps:'));
    console.log(`  1. Start tmux and open panes for your AI agents`);
    console.log(`  2. Run ${colors.cyan('tmux-team setup')} to configure agents`);
    console.log(`  3. Use ${colors.cyan('tmux-team talk <agent> "message" --wait')}`);
    console.log();
  } finally {
    rl.close();
  }
}
