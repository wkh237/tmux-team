// ─────────────────────────────────────────────────────────────
// upgrade command - update the npm package
// ─────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import type { Context } from '../types.js';
import { ExitCodes } from '../exits.js';
import { isNewerVersion } from '../update-check.js';
import { VERSION } from '../version.js';

export function cmdUpgrade(ctx: Context): void {
  if (ctx.flags.json) {
    ctx.ui.error('tmt upgrade cannot be used with --json because npm streams installer output.');
    ctx.exit(ExitCodes.ERROR);
  }
  try {
    const latest = execFileSync('npm', ['view', 'tmux-team', 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!isNewerVersion(latest, VERSION)) {
      ctx.ui.success(`tmux-team is already up to date (${VERSION}).`);
      return;
    }
    ctx.ui.info('Updating tmux-team from npm…');
    execFileSync('npm', ['install', '--global', 'tmux-team@latest'], { stdio: 'inherit' });
    ctx.ui.success('tmux-team upgraded. Managed skill links now use the updated bundled files.');
    ctx.ui.info(
      'If an integration is missing or has drifted, run `tmt install --force` to repair it.'
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    ctx.ui.error(`Upgrade failed: ${detail}`);
    ctx.exit(ExitCodes.ERROR);
  }
}
