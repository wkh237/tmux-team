// ─────────────────────────────────────────────────────────────
// remove command - unregister an agent
// ─────────────────────────────────────────────────────────────

import type { Context } from '../types.js';
import { ExitCodes } from '../exits.js';
import { loadLocalConfigFile, saveLocalConfigFile } from '../config.js';
import { getRegistryScope } from '../registry.js';

export function cmdRemove(ctx: Context, name: string): void {
  const { ui, config, paths, flags, tmux, exit } = ctx;

  if (!config.paneRegistry[name]) {
    ui.error(`Agent '${name}' not found.`);
    exit(ExitCodes.PANE_NOT_FOUND);
  }

  const removedFromTmux = tmux.clearAgentRegistration(name, getRegistryScope(ctx));
  if (!removedFromTmux) {
    // Legacy fallback: remove from tmux-team.json when this scope still uses it.
    const localConfig = loadLocalConfigFile(paths);
    delete localConfig[name];
    saveLocalConfigFile(paths, localConfig);
  }

  if (flags.json) {
    ui.json({ removed: name, source: removedFromTmux ? 'tmux' : 'legacy' });
  } else {
    ui.success(`Removed agent '${name}'`);
  }
}
