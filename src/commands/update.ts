// ─────────────────────────────────────────────────────────────
// update command - modify agent config
// ─────────────────────────────────────────────────────────────

import type { Context } from '../types.js';
import { ExitCodes } from '../exits.js';
import { saveLocalConfig } from '../config.js';

export function cmdUpdate(
  ctx: Context,
  name: string,
  options: { pane?: string; remark?: string }
): void {
  const { ui, config, paths, flags, exit } = ctx;

  if (!config.paneRegistry[name]) {
    ui.error(`Agent '${name}' not found. Use 'tmux-team add' to create.`);
    exit(ExitCodes.PANE_NOT_FOUND);
  }

  if (!options.pane && !options.remark) {
    ui.error('No updates specified. Use --pane or --remark.');
    exit(ExitCodes.ERROR);
  }

  const updates: string[] = [];

  if (options.pane) {
    config.paneRegistry[name].pane = options.pane;
    updates.push(`pane → ${options.pane}`);
  }

  if (options.remark) {
    config.paneRegistry[name].remark = options.remark;
    updates.push(`remark updated`);
  }

  saveLocalConfig(paths, config.paneRegistry);

  if (flags.json) {
    ui.json({ updated: name, ...options });
  } else {
    for (const update of updates) {
      ui.success(`Updated '${name}': ${update}`);
    }
  }
}
