// ─────────────────────────────────────────────────────────────
// list command - show configured agents
// ─────────────────────────────────────────────────────────────

import type { Context } from '../types.js';

export function cmdList(ctx: Context): void {
  const { ui, config, flags } = ctx;
  const agents = Object.entries(config.paneRegistry);

  if (flags.json) {
    ui.json(config.paneRegistry);
    return;
  }

  if (agents.length === 0) {
    ui.info("No agents configured. Use 'tmux-team add <name> <pane>' to add one.");
    return;
  }

  console.log();
  ui.table(
    ['NAME', 'PANE', 'REMARK'],
    agents.map(([name, data]) => [name, data.pane, data.remark || '-'])
  );
  console.log();
}
