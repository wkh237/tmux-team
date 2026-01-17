// ─────────────────────────────────────────────────────────────
// init command - create tmux-team.json or shared team config
// ─────────────────────────────────────────────────────────────

import fs from 'fs';
import type { Context } from '../types.js';
import { ExitCodes } from '../exits.js';
import { ensureTeamsDir } from '../config.js';

export function cmdInit(ctx: Context): void {
  const { ui, paths, flags, exit } = ctx;

  // Ensure teams directory exists if using --team
  if (flags.team) {
    ensureTeamsDir(paths.globalDir);
  }

  if (fs.existsSync(paths.localConfig)) {
    ui.error(`${paths.localConfig} already exists. Remove it first if you want to reinitialize.`);
    exit(ExitCodes.ERROR);
  }

  fs.writeFileSync(paths.localConfig, '{}\n');

  if (flags.json) {
    ui.json({ created: paths.localConfig, team: flags.team });
  } else {
    if (flags.team) {
      ui.success(`Created shared team "${flags.team}" at ${paths.localConfig}`);
    } else {
      ui.success(`Created ${paths.localConfig}`);
    }
  }
}
