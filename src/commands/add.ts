// ─────────────────────────────────────────────────────────────
// add command - register a new agent
// ─────────────────────────────────────────────────────────────

import type { Context } from '../types.js';
import { ExitCodes } from '../exits.js';
import { bindIdentity, failIdentity, resolvePane } from './global-identity.js';
import { isPaneTarget } from '../domain/names.js';

/**
 * Add uses the v5 order `add <pane-target> <global-name>`.  Detect the v4
 * order before resolving anything so a migration hint cannot accidentally
 * mutate metadata or even probe a stale pane.
 */
export function cmdAdd(ctx: Context, pane: string, name: string): void {
  if (!isPaneTarget(pane) && isPaneTarget(name)) {
    const message =
      'The v4 add argument order is no longer supported. Use: tmt add <pane-target> <global-name>.';
    if (ctx.flags.json) {
      ctx.ui.json({
        error: {
          code: 'LEGACY_ADD_ORDER',
          message: 'The v4 add argument order is no longer supported.',
          suggestion: `Use: tmt add ${name} ${pane}`,
        },
      });
    } else {
      ctx.ui.error(`${message} Suggested command: tmt add ${name} ${pane}`);
    }
    return ctx.exit(ExitCodes.ERROR);
  }

  const resolvedPane = resolvePane(ctx, pane);
  if (!resolvedPane) {
    failIdentity(ctx, 'PANE_NOT_FOUND', `Pane target '${pane}' was not found.`);
  }
  bindIdentity(ctx, resolvedPane, name);
}
