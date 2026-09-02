// ─────────────────────────────────────────────────────────────
// add command - register a new agent
// ─────────────────────────────────────────────────────────────

import type { Context } from '../types.js';
import { bindIdentity, failIdentity, resolvePane } from './global-identity.js';

export function cmdAdd(ctx: Context, pane: string, name: string): void {
  const resolvedPane = resolvePane(ctx, pane);
  if (!resolvedPane) {
    failIdentity(ctx, 'PANE_NOT_FOUND', `Pane '${pane}' not found. Is tmux running?`);
  }
  bindIdentity(ctx, resolvedPane, name);
}
