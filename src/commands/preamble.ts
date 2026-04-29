// ─────────────────────────────────────────────────────────────
// Preamble command - manage agent preambles (local config only)
// ─────────────────────────────────────────────────────────────

import type { Context } from '../types.js';
import { ExitCodes } from '../context.js';
import { loadLocalConfigFile, saveLocalConfigFile } from '../config.js';
import { getRegistryScope, registrationFromEntry } from '../registry.js';

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
 * Set preamble for an agent (in local config).
 */
function setPreamble(ctx: Context, agentName: string, preamble: string): void {
  const { ui, paths, flags, config, tmux } = ctx;

  // Check if agent exists in pane registry
  if (!config.paneRegistry[agentName]) {
    ui.error(`Agent '${agentName}' not found in local config`);
    ui.error('Add the agent with: tmux-team add <agent> <pane>');
    ctx.exit(ExitCodes.ERROR);
  }

  const pane = tmux.resolvePaneTarget(config.paneRegistry[agentName].pane);
  if (!pane) {
    ui.error(`Pane '${config.paneRegistry[agentName].pane}' not found. Is tmux running?`);
    ctx.exit(ExitCodes.PANE_NOT_FOUND);
  }

  const nextEntry = { ...config.paneRegistry[agentName], pane, preamble };
  tmux.setAgentRegistration(
    pane,
    getRegistryScope(ctx),
    registrationFromEntry(agentName, nextEntry)
  );
  updateLegacyPreambleIfPresent(paths, agentName, preamble);

  if (flags.json) {
    ui.json({ agent: agentName, preamble, status: 'set' });
  } else {
    ui.success(`Set preamble for ${agentName}`);
  }
}

/**
 * Clear preamble for an agent (in local config).
 */
function clearPreamble(ctx: Context, agentName: string): void {
  const { ui, paths, flags, config, tmux } = ctx;

  const entry = config.paneRegistry[agentName];
  const hasPreamble =
    entry?.preamble !== undefined ||
    config.agents[agentName]?.preamble !== undefined ||
    legacyHasPreamble(paths, agentName);

  if (entry && hasPreamble) {
    const pane = tmux.resolvePaneTarget(entry.pane);
    if (!pane) {
      ui.error(`Pane '${entry.pane}' not found. Is tmux running?`);
      ctx.exit(ExitCodes.PANE_NOT_FOUND);
    }
    const nextEntry = { ...entry, pane };
    delete nextEntry.preamble;
    tmux.setAgentRegistration(
      pane,
      getRegistryScope(ctx),
      registrationFromEntry(agentName, nextEntry)
    );
    clearLegacyPreambleIfPresent(paths, agentName);

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

function updateLegacyPreambleIfPresent(
  paths: Context['paths'],
  agentName: string,
  preamble: string
): void {
  const localConfig = loadLocalConfigFile(paths);
  const agentEntry = localConfig[agentName] as { pane?: string; preamble?: string } | undefined;
  if (!agentEntry) return;
  agentEntry.preamble = preamble;
  saveLocalConfigFile(paths, localConfig);
}

function clearLegacyPreambleIfPresent(paths: Context['paths'], agentName: string): void {
  const localConfig = loadLocalConfigFile(paths);
  const agentEntry = localConfig[agentName] as { pane?: string; preamble?: string } | undefined;
  if (!agentEntry || !Object.prototype.hasOwnProperty.call(agentEntry, 'preamble')) return;
  delete agentEntry.preamble;
  saveLocalConfigFile(paths, localConfig);
}

function legacyHasPreamble(paths: Context['paths'], agentName: string): boolean {
  const localConfig = loadLocalConfigFile(paths);
  const agentEntry = localConfig[agentName] as { pane?: string; preamble?: string } | undefined;
  return Boolean(agentEntry && Object.prototype.hasOwnProperty.call(agentEntry, 'preamble'));
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
