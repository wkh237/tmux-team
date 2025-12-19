// ─────────────────────────────────────────────────────────────
// init command - create tmux-team.json
// ─────────────────────────────────────────────────────────────

import fs from 'fs';
import type { Context } from '../types.js';
import { ExitCodes } from '../exits.js';

export function cmdInit(ctx: Context): void {
  const { ui, paths, flags, exit } = ctx;

  if (fs.existsSync(paths.localConfig)) {
    ui.error(`${paths.localConfig} already exists. Remove it first if you want to reinitialize.`);
    exit(ExitCodes.ERROR);
  }

  fs.writeFileSync(paths.localConfig, '{}\n');

  if (flags.json) {
    ui.json({ created: paths.localConfig });
  } else {
    ui.success(`Created ${paths.localConfig}`);
  }
}
