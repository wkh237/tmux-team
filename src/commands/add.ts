// ─────────────────────────────────────────────────────────────
// add command - register a new agent
// ─────────────────────────────────────────────────────────────

import fs from 'fs';
import type { Context, PaneEntry } from '../types.js';
import { ExitCodes } from '../exits.js';
import { loadLocalConfigFile, saveLocalConfigFile, ensureTeamsDir } from '../config.js';

export function cmdAdd(ctx: Context, name: string, pane: string, remark?: string): void {
  const { ui, config, paths, flags, exit } = ctx;

  // Ensure teams directory exists if using --team
  if (flags.team) {
    ensureTeamsDir(paths.globalDir);
  }

  // Create config file if it doesn't exist
  if (!fs.existsSync(paths.localConfig)) {
    fs.writeFileSync(paths.localConfig, '{}\n');
    if (!flags.json) {
      if (flags.team) {
        ui.info(`Created shared team "${flags.team}"`);
      } else {
        ui.info(`Created ${paths.localConfig}`);
      }
    }
  }

  if (config.paneRegistry[name]) {
    ui.error(`Agent '${name}' already exists. Use 'tmux-team update' to modify.`);
    exit(ExitCodes.ERROR);
  }

  // Load existing config to preserve all fields (preamble, deny, etc.)
  const localConfig = loadLocalConfigFile(paths);

  const newEntry: PaneEntry = { pane };
  if (remark) {
    newEntry.remark = remark;
  }
  localConfig[name] = newEntry;

  saveLocalConfigFile(paths, localConfig);

  if (flags.json) {
    ui.json({ added: name, pane, remark, team: flags.team });
  } else {
    if (flags.team) {
      ui.success(`Added agent '${name}' to team "${flags.team}" at pane ${pane}`);
    } else {
      ui.success(`Added agent '${name}' at pane ${pane}`);
    }
  }
}
