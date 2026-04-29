// ─────────────────────────────────────────────────────────────
// add command - register a new agent
// ─────────────────────────────────────────────────────────────

import type { Context } from '../types.js';
import { ExitCodes } from '../exits.js';
import { getRegistryScope, registrationFromEntry } from '../registry.js';

export function cmdAdd(ctx: Context, name: string, pane: string, remark?: string): void {
  const { ui, config, tmux, flags, exit } = ctx;

  if (config.paneRegistry[name]) {
    ui.error(`Agent '${name}' already exists. Use 'tmux-team update' to modify.`);
    exit(ExitCodes.ERROR);
  }

  const resolvedPane = tmux.resolvePaneTarget(pane);
  if (!resolvedPane) {
    ui.error(`Pane '${pane}' not found. Is tmux running?`);
    exit(ExitCodes.PANE_NOT_FOUND);
  }
  const paneId = resolvedPane as string;

  const scope = getRegistryScope(ctx);
  const registration = registrationFromEntry(name, {
    pane: paneId,
    ...(remark !== undefined && { remark }),
  });
  tmux.setAgentRegistration(paneId, scope, registration);

  if (flags.json) {
    ui.json({ added: name, pane: paneId, remark, team: flags.team });
  } else {
    if (flags.team) {
      ui.success(`Added agent '${name}' to team "${flags.team}" at pane ${paneId}`);
    } else {
      ui.success(`Added agent '${name}' at pane ${paneId}`);
    }
  }
}
