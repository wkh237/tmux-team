// ─────────────────────────────────────────────────────────────
// update command - modify agent config
// ─────────────────────────────────────────────────────────────

import type { Context, PaneEntry } from '../types.js';
import { ExitCodes } from '../exits.js';
import { loadLocalConfigFile, saveLocalConfigFile } from '../config.js';
import { getRegistryScope, registrationFromEntry } from '../registry.js';

export function cmdUpdate(
  ctx: Context,
  name: string,
  options: { pane?: string; remark?: string }
): void {
  const { ui, config, paths, flags, tmux, exit } = ctx;

  if (!config.paneRegistry[name]) {
    ui.error(`Agent '${name}' not found. Use 'tmux-team add' to create.`);
    exit(ExitCodes.PANE_NOT_FOUND);
  }

  if (!options.pane && !options.remark) {
    ui.error('No updates specified. Use --pane or --remark.');
    exit(ExitCodes.ERROR);
  }

  let entry: PaneEntry = { ...config.paneRegistry[name] };

  const updates: string[] = [];

  if (options.pane) {
    const resolvedPane = tmux.resolvePaneTarget(options.pane);
    if (!resolvedPane) {
      ui.error(`Pane '${options.pane}' not found. Is tmux running?`);
      exit(ExitCodes.PANE_NOT_FOUND);
    }
    entry.pane = resolvedPane as string;
    updates.push(`pane → ${entry.pane}`);
  }

  if (options.remark) {
    entry.remark = options.remark;
    updates.push(`remark updated`);
  }

  const canonicalPane = tmux.resolvePaneTarget(entry.pane);
  if (!canonicalPane) {
    ui.error(`Pane '${entry.pane}' not found. Is tmux running?`);
    exit(ExitCodes.PANE_NOT_FOUND);
  }
  entry.pane = canonicalPane as string;

  const scope = getRegistryScope(ctx);
  const updatedLegacy = updateLegacyEntryIfPresent(paths, name, entry);
  const removed = options.pane ? tmux.clearAgentRegistration(name, scope) : false;
  tmux.setAgentRegistration(entry.pane, scope, registrationFromEntry(name, entry));

  if (updatedLegacy && removed) {
    pruneLegacyEntry(paths, name);
  }

  if (flags.json) {
    ui.json({ updated: name, ...options });
  } else {
    for (const update of updates) {
      ui.success(`Updated '${name}': ${update}`);
    }
  }
}

function updateLegacyEntryIfPresent(
  paths: Context['paths'],
  name: string,
  entry: PaneEntry
): boolean {
  const localConfig = loadLocalConfigFile(paths);
  if (!localConfig[name]) return false;

  localConfig[name] = { ...entry };
  saveLocalConfigFile(paths, localConfig);
  return true;
}

function pruneLegacyEntry(paths: Context['paths'], name: string): void {
  const localConfig = loadLocalConfigFile(paths);
  if (!localConfig[name]) return;
  delete localConfig[name];
  saveLocalConfigFile(paths, localConfig);
}
