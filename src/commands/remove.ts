// ─────────────────────────────────────────────────────────────
// remove command - unregister an agent
// ─────────────────────────────────────────────────────────────

import type { Context } from '../types.js';
import { ExitCodes } from '../exits.js';
import { loadLocalConfigFile, saveLocalConfigFile } from '../config.js';

export function cmdRemove(ctx: Context, name: string): void {
  const { ui, config, paths, flags, exit } = ctx;

  if (!config.paneRegistry[name]) {
    ui.error(`Agent '${name}' not found.`);
    exit(ExitCodes.PANE_NOT_FOUND);
  }

  // Load existing config to preserve other agents' fields (preamble, deny, etc.)
  const localConfig = loadLocalConfigFile(paths);
  delete localConfig[name];
  saveLocalConfigFile(paths, localConfig);

  if (flags.json) {
    ui.json({ removed: name });
  } else {
    ui.success(`Removed agent '${name}'`);
  }
}
