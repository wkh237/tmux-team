import type { Context } from '../types.js';
import { failIdentity, resolveCurrentPane } from './global-identity.js';

export function cmdWhoami(ctx: Context): void {
  const paneId = resolveCurrentPane(ctx);
  if (!paneId) failIdentity(ctx, 'PANE_NOT_FOUND', 'Not running inside a resolvable tmux pane.');

  if (ctx.identityService) {
    const current = ctx.identityService.currentIdentity();
    if (ctx.flags.json) {
      ctx.ui.json(
        current
          ? { bound: true, name: current.identity.name, pane: paneId }
          : { bound: false, pane: paneId }
      );
    } else if (current) {
      ctx.ui.info(`Bound identity '${current.identity.name}' on pane ${paneId}`);
    } else {
      ctx.ui.info(`Pane ${paneId} is unbound.`);
    }
    return;
  }
  const identity = ctx.tmux.listGlobalIdentities().find((entry) => entry.paneId === paneId);
  if (ctx.flags.json) {
    ctx.ui.json(
      identity ? { bound: true, name: identity.name, pane: paneId } : { bound: false, pane: paneId }
    );
  } else if (identity) {
    ctx.ui.info(`Bound identity '${identity.name}' on pane ${paneId}`);
  } else {
    ctx.ui.info(`Pane ${paneId} is unbound.`);
  }
}
