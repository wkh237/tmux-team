// ─────────────────────────────────────────────────────────────
// remove command - unregister an agent
// ─────────────────────────────────────────────────────────────

import type { Context } from '../types.js';
import { ExitCodes } from '../exits.js';
import { saveLocalConfig } from '../config.js';

export function cmdRemove(ctx: Context, name: string): void {
  const { ui, config, paths, flags, exit } = ctx;

  if (!config.paneRegistry[name]) {
    ui.error(`Agent '${name}' not found.`);
    exit(ExitCodes.PANE_NOT_FOUND);
  }

  delete config.paneRegistry[name];
  saveLocalConfig(paths, config.paneRegistry);

  if (flags.json) {
    ui.json({ removed: name });
  } else {
    ui.success(`Removed agent '${name}'`);
  }
}
