// ─────────────────────────────────────────────────────────────
// Preamble command - manage agent preambles
// ─────────────────────────────────────────────────────────────

import type { Context } from '../types.js';
import { ExitCodes } from '../context.js';
import { loadGlobalConfig, saveGlobalConfig } from '../config.js';

/**
 * Show preamble(s) for agent(s).
 */
function showPreamble(ctx: Context, agentName?: string): void {
  const { ui, config, flags } = ctx;

  if (agentName) {
    // Show specific agent's preamble
    const agentConfig = config.agents[agentName];
    const preamble = agentConfig?.preamble;

    if (flags.json) {
      ui.json({ agent: agentName, preamble: preamble ?? null });
      return;
    }

    if (preamble) {
      ui.info(`Preamble for ${agentName}:`);
      console.log(preamble);
    } else {
      ui.info(`No preamble set for ${agentName}`);
    }
  } else {
    // Show all preambles
    const preambles: { agent: string; preamble: string }[] = [];

    for (const [name, agentConfig] of Object.entries(config.agents)) {
      if (agentConfig.preamble) {
        preambles.push({ agent: name, preamble: agentConfig.preamble });
      }
    }

    if (flags.json) {
      ui.json({ preambles });
      return;
    }

    if (preambles.length === 0) {
      ui.info('No preambles configured');
      return;
    }

    for (const { agent, preamble } of preambles) {
      console.log(`─── ${agent} ───`);
      console.log(preamble);
      console.log();
    }
  }
}

/**
 * Set preamble for an agent.
 */
function setPreamble(ctx: Context, agentName: string, preamble: string): void {
  const { ui, paths, flags } = ctx;

  const globalConfig = loadGlobalConfig(paths);

  // Ensure agents object exists
  if (!globalConfig.agents) {
    globalConfig.agents = {};
  }

  // Ensure agent config exists
  if (!globalConfig.agents[agentName]) {
    globalConfig.agents[agentName] = {};
  }

  globalConfig.agents[agentName].preamble = preamble;
  saveGlobalConfig(paths, globalConfig);

  if (flags.json) {
    ui.json({ agent: agentName, preamble, status: 'set' });
  } else {
    ui.success(`Set preamble for ${agentName}`);
  }
}

/**
 * Clear preamble for an agent.
 */
function clearPreamble(ctx: Context, agentName: string): void {
  const { ui, paths, flags } = ctx;

  const globalConfig = loadGlobalConfig(paths);

  if (globalConfig.agents?.[agentName]?.preamble) {
    delete globalConfig.agents[agentName].preamble;

    // Clean up empty agent config
    if (Object.keys(globalConfig.agents[agentName]).length === 0) {
      delete globalConfig.agents[agentName];
    }

    saveGlobalConfig(paths, globalConfig);

    if (flags.json) {
      ui.json({ agent: agentName, status: 'cleared' });
    } else {
      ui.success(`Cleared preamble for ${agentName}`);
    }
  } else {
    if (flags.json) {
      ui.json({ agent: agentName, status: 'not_set' });
    } else {
      ui.info(`No preamble was set for ${agentName}`);
    }
  }
}

/**
 * Preamble command entry point.
 */
export function cmdPreamble(ctx: Context, args: string[]): void {
  const subcommand = args[0];

  switch (subcommand) {
    case undefined:
    case 'show':
      showPreamble(ctx, args[1]);
      break;

    case 'set':
      if (args.length < 3) {
        ctx.ui.error('Usage: tmux-team preamble set <agent> <preamble>');
        ctx.exit(ExitCodes.ERROR);
      }
      // Join remaining args as preamble (allows spaces without quotes)
      setPreamble(ctx, args[1], args.slice(2).join(' '));
      break;

    case 'clear':
      if (args.length < 2) {
        ctx.ui.error('Usage: tmux-team preamble clear <agent>');
        ctx.exit(ExitCodes.ERROR);
      }
      clearPreamble(ctx, args[1]);
      break;

    default:
      ctx.ui.error(`Unknown preamble subcommand: ${subcommand}`);
      ctx.ui.error('Usage: tmux-team preamble [show|set|clear]');
      ctx.exit(ExitCodes.ERROR);
  }
}
