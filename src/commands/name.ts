// name command - bind a global identity to the current tmux pane

import type { Context } from '../types.js';
import { failIdentity, bindIdentity, resolveCurrentPane } from './global-identity.js';

export function cmdName(ctx: Context, name: string): void {
  const paneId = resolveCurrentPane(ctx);
  if (!paneId) {
    failIdentity(ctx, 'PANE_NOT_FOUND', 'Not running inside a resolvable tmux pane.');
  }
  bindIdentity(ctx, paneId, name);
}
