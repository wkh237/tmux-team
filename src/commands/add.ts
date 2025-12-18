// ─────────────────────────────────────────────────────────────
// add command - register a new agent
// ─────────────────────────────────────────────────────────────

import fs from 'fs';
import type { Context } from '../types.js';
import { ExitCodes } from '../exits.js';
import { saveLocalConfig } from '../config.js';

export function cmdAdd(ctx: Context, name: string, pane: string, remark?: string): void {
  const { ui, config, paths, flags, exit } = ctx;

  // Create config file if it doesn't exist
  if (!fs.existsSync(paths.localConfig)) {
    fs.writeFileSync(paths.localConfig, '{}\n');
    if (!flags.json) {
      ui.info(`Created ${paths.localConfig}`);
    }
  }

  if (config.paneRegistry[name]) {
    ui.error(`Agent '${name}' already exists. Use 'tmux-team update' to modify.`);
    exit(ExitCodes.ERROR);
  }

  config.paneRegistry[name] = { pane };
  if (remark) {
    config.paneRegistry[name].remark = remark;
  }

  saveLocalConfig(paths, config.paneRegistry);

  if (flags.json) {
    ui.json({ added: name, pane, remark });
  } else {
    ui.success(`Added agent '${name}' at pane ${pane}`);
  }
}
