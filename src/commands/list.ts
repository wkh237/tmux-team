// ─────────────────────────────────────────────────────────────
// list command - show configured agents
// ─────────────────────────────────────────────────────────────

import type { Context } from '../types.js';

export function cmdList(ctx: Context): void {
  const { ui, config, flags } = ctx;
  const agents = Object.entries(config.paneRegistry);

  if (flags.json) {
    ui.json({ team: flags.team, agents: config.paneRegistry });
    return;
  }

  if (agents.length === 0) {
    if (flags.team) {
      ui.info(`No agents in team "${flags.team}". Use 'tmt this <name> --team ${flags.team}' to add one.`);
    } else {
      ui.info("No agents configured. Use 'tmux-team add <name> <pane>' to add one.");
    }
    return;
  }

  console.log();
  if (flags.team) {
    console.log(`Team: ${flags.team}`);
    console.log();
  }
  ui.table(
    ['NAME', 'PANE', 'REMARK'],
    agents.map(([name, data]) => [name, data.pane, data.remark || '-'])
  );
  console.log();
}
