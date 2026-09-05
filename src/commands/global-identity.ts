import type { BindingErrorCode } from '../domain/types.js';
import type { Context } from '../types.js';
import { ExitCodes } from '../exits.js';
import { IdentityServiceError } from '../identity-service.js';

export function resolveCurrentPane(ctx: Context): string | null {
  const current = ctx.tmux.getCurrentPaneId();
  return current;
}

export function resolvePane(ctx: Context, target: string): string | null {
  return ctx.tmux.resolvePaneTarget(target);
}

export function failIdentity(
  ctx: Context,
  code: BindingErrorCode | 'PANE_NOT_FOUND' | 'NAME_NOT_FOUND' | 'RECONCILIATION_FAILED',
  message: string
): never {
  if (ctx.flags.json) {
    ctx.ui.json({ error: { code, message } });
  } else {
    ctx.ui.error(message);
  }

  const exitCode =
    code === 'PANE_NOT_FOUND'
      ? ExitCodes.PANE_NOT_FOUND
      : code === 'PANE_ALREADY_BOUND' || code === 'NAME_ALREADY_ACTIVE'
        ? ExitCodes.CONFLICT
        : ExitCodes.ERROR;
  return ctx.exit(exitCode);
}

export function bindIdentity(
  ctx: Context,
  paneId: string,
  name: string,
  options: { readonly current?: boolean } = {}
): void {
  try {
    const identity = options.current
      ? ctx.identityService.bindCurrent(name)
      : ctx.identityService.bindPane(paneId, name);
    try {
      ctx.tmux.setPaneTitle(paneId, identity.name);
    } catch {
      // Identity metadata is authoritative; title synchronization is presentation only.
    }
    if (ctx.flags.json) ctx.ui.json({ bound: true, name: identity.name, pane: paneId });
    else ctx.ui.success(`Bound '${identity.name}' to pane ${paneId}`);
    return;
  } catch (error) {
    // Preserve the service's typed errors for the command boundary below.
    if (error instanceof IdentityServiceError) failIdentity(ctx, error.code, error.message);
    throw error;
  }
}

export function unbindIdentity(ctx: Context, paneId: string): void {
  try {
    const identity = ctx.identityService.unbindCurrent();
    if (!identity) {
      failIdentity(ctx, 'UNBOUND_PANE', 'Pane has no active global name.');
    }
    if (ctx.flags.json) {
      ctx.ui.json({ unbound: true, name: identity.name, pane: paneId });
    } else ctx.ui.success(`Unbound pane ${paneId}`);
    return;
  } catch (error) {
    if (error instanceof IdentityServiceError) failIdentity(ctx, error.code, error.message);
    throw error;
  }
}
