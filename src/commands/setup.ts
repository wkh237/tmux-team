// ─────────────────────────────────────────────────────────────
// setup command - interactive wizard for configuring agents
// ─────────────────────────────────────────────────────────────

import fs from 'fs';
import readline from 'readline';
import type { Context, PaneEntry, PaneInfo, LocalConfigFile } from '../types.js';
import { ExitCodes } from '../exits.js';
import { loadLocalConfigFile, saveLocalConfigFile } from '../config.js';
import { colors } from '../ui.js';

async function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function promptWithDefault(
  rl: readline.Interface,
  question: string,
  defaultValue: string
): Promise<string> {
  const answer = await prompt(rl, `${question} [${defaultValue}]: `);
  return answer || defaultValue;
}

async function confirm(rl: readline.Interface, question: string): Promise<boolean> {
  const answer = await prompt(rl, `${question} [Y/n]: `);
  return answer.toLowerCase() !== 'n';
}

export async function cmdSetup(ctx: Context): Promise<void> {
  const { ui, tmux, paths, exit } = ctx;

  // Check if in tmux
  if (!process.env.TMUX) {
    ui.error('Not running inside tmux. Please run this command from within a tmux session.');
    exit(ExitCodes.ERROR);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log();
    ui.info('Detecting tmux panes...');
    console.log();

    const panes = tmux.listPanes();
    const currentPaneId = tmux.getCurrentPaneId();

    if (panes.length === 0) {
      ui.error('No tmux panes found.');
      exit(ExitCodes.ERROR);
    }

    // Filter out current pane
    const otherPanes = panes.filter((p) => p.id !== currentPaneId);

    if (otherPanes.length === 0) {
      ui.warn('No other panes found. Create more tmux panes with other agents first.');
      ui.info('Hint: Use Ctrl+B % or Ctrl+B " to split panes, then start your AI agents.');
      exit(ExitCodes.ERROR);
    }

    // Show detected panes
    console.log(colors.yellow('Found panes:'));
    console.log(`  ${colors.dim(currentPaneId || '?')} ${colors.dim('(current pane - skipped)')}`);
    for (const pane of otherPanes) {
      const detected = pane.suggestedName
        ? colors.green(pane.suggestedName)
        : colors.dim('(unknown)');
      console.log(`  ${pane.id} running "${pane.command}" → detected: ${detected}`);
    }
    console.log();

    // Load existing config
    let localConfig: LocalConfigFile = {};
    if (fs.existsSync(paths.localConfig)) {
      localConfig = loadLocalConfigFile(paths);
    }

    const agents: Record<string, PaneEntry> = {};
    let configuredCount = 0;

    // Configure each pane
    for (const pane of otherPanes) {
      const detected = pane.suggestedName || '';

      console.log(colors.cyan(`Configure pane ${pane.id}?`));
      if (pane.suggestedName) {
        console.log(`  Detected: ${colors.green(pane.suggestedName)}`);
      }

      // Ask for name
      let name: string;
      if (detected) {
        name = await promptWithDefault(rl, '  Name', detected);
      } else {
        name = await prompt(rl, '  Name (or press Enter to skip): ');
        if (!name) {
          console.log(colors.dim('  Skipped'));
          console.log();
          continue;
        }
      }

      // Validate name
      if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) {
        ui.warn(
          '  Invalid name. Use letters, numbers, underscores, hyphens. Starting with a letter.'
        );
        console.log(colors.dim('  Skipped'));
        console.log();
        continue;
      }

      // Ask for optional remark
      const remark = await prompt(rl, '  Remark (optional): ');

      const entry: PaneEntry = { pane: pane.id };
      if (remark) {
        entry.remark = remark;
      }

      agents[name] = entry;
      configuredCount++;
      console.log();
    }

    if (configuredCount === 0) {
      ui.warn('No agents configured.');
      exit(ExitCodes.SUCCESS);
    }

    // Merge with existing config (preserve $config and existing agents)
    const newConfig: LocalConfigFile = { ...localConfig };
    for (const [name, entry] of Object.entries(agents)) {
      newConfig[name] = entry;
    }

    // Save config
    if (!fs.existsSync(paths.localConfig)) {
      fs.writeFileSync(paths.localConfig, '{}\n');
    }
    saveLocalConfigFile(paths, newConfig);

    ui.success(`Created ${paths.localConfig} with ${configuredCount} agent(s)`);
    console.log();

    // Show next steps
    const firstAgent = Object.keys(agents)[0];
    console.log(colors.yellow('Try it:'));
    console.log(`  ${colors.cyan(`tmux-team talk ${firstAgent} "hello" --wait`)}`);
    console.log();
  } finally {
    rl.close();
  }
}
