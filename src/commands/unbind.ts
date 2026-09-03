import type { Context } from '../types.js';
import { resolveCurrentPane, unbindIdentity, failIdentity } from './global-identity.js';

export function cmdUnbind(ctx: Context): void {
  const paneId = resolveCurrentPane(ctx);
  if (!paneId) failIdentity(ctx, 'PANE_NOT_FOUND', 'Not running inside a resolvable tmux pane.');
  unbindIdentity(ctx, paneId);
}
