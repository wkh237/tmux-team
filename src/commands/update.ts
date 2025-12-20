// ─────────────────────────────────────────────────────────────
// update command - modify agent config
// ─────────────────────────────────────────────────────────────

import type { Context, PaneEntry } from '../types.js';
import { ExitCodes } from '../exits.js';
import { loadLocalConfigFile, saveLocalConfigFile } from '../config.js';

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

  // Load existing config to preserve all fields (preamble, deny, etc.)
  const localConfig = loadLocalConfigFile(paths);

  // Handle edge case where local config was modified externally
  let entry = localConfig[name] as PaneEntry | undefined;
  if (!entry) {
    // Fall back to in-memory paneRegistry if entry is missing
    entry = { ...config.paneRegistry[name] };
    localConfig[name] = entry;
  }

  const updates: string[] = [];

  if (options.pane) {
    entry.pane = options.pane;
    updates.push(`pane → ${options.pane}`);
  }

  if (options.remark) {
    entry.remark = options.remark;
    updates.push(`remark updated`);
  }

  saveLocalConfigFile(paths, localConfig);

  if (flags.json) {
    ui.json({ updated: name, ...options });
  } else {
    for (const update of updates) {
      ui.success(`Updated '${name}': ${update}`);
    }
  }
}
