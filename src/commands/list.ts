// ─────────────────────────────────────────────────────────────
// list command - show configured agents
// ─────────────────────────────────────────────────────────────

import type { Context } from '../types.js';
import { listPaneStatus, listTeamMembers } from './team.js';

export function cmdList(ctx: Context, target?: string): void {
  const { ui, config, flags } = ctx;

  if (target) {
    const teams = ctx.tmux.listTeams();
    if (teams[target]) {
      listTeamMembers(ctx, [target]);
      return;
    }

    listPaneStatus(ctx, target);
    return;
  }

  const agents = Object.entries(config.paneRegistry);

  if (flags.json) {
    ui.json({ team: flags.team, agents: config.paneRegistry });
    return;
  }

  if (agents.length === 0) {
    if (flags.team) {
      ui.info(
        `No agents in team "${flags.team}". Use 'tmt this <name> --team ${flags.team}' to add one.`
      );
    } else {
      ui.info("No agents configured. Use 'tmux-team add <name> <pane>' to add one.");
    }
    return;
  }

  console.log();
  if (flags.team) {
    console.log(`Team: ${flags.team}`);
    console.log();
  } else if (config.registrySource === 'legacy') {
    ui.warn(
      'Using legacy tmux-team.json registry. Run `tmt migrate` to store registrations in tmux.'
    );
  }
  ui.table(
    ['NAME', 'PANE', 'REMARK'],
    agents.map(([name, data]) => [name, data.pane, data.remark || '-'])
  );
  console.log();
}
