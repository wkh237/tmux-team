// ─────────────────────────────────────────────────────────────
// list command - show active global identities and pane status
// ─────────────────────────────────────────────────────────────

import type { Context, PaneInfo } from '../types.js';
import { ExitCodes } from '../exits.js';
import { resolveTarget, sortedGlobalIdentities } from '../target-resolver.js';
import { normalizeName } from '../domain/names.js';

type PublicIdentity = { name: string; canonicalName: string };

function publicIdentity(identity: PublicIdentity): PublicIdentity {
  return {
    name: identity.name,
    canonicalName: identity.canonicalName || normalizeName(identity.name),
  };
}

function paneDetails(ctx: Context, paneId: string, panes?: Map<string, PaneInfo>) {
  const paneMap = panes ?? new Map(ctx.tmux.listPanes().map((pane) => [pane.id, pane]));
  const pane = paneMap.get(paneId);
  return {
    id: paneId,
    ...(pane?.target && { target: pane.target }),
    ...(pane?.cwd && { cwd: pane.cwd }),
    command: pane?.command ?? '',
  };
}

export function cmdList(ctx: Context, target?: string): void {
  const { ui, tmux, flags, exit } = ctx;

  if (target !== undefined) {
    const resolution = resolveTarget(tmux, target);
    if (!resolution.ok) {
      if (flags.json) ui.json({ error: resolution.error });
      else ui.error(resolution.error.message);
      return exit(
        resolution.error.code === 'NAME_NOT_FOUND'
          ? ExitCodes.NAME_NOT_FOUND
          : ExitCodes.PANE_NOT_FOUND
      );
    }

    const identity = resolution.value.identity;
    const pane = paneDetails(ctx, resolution.value.paneId);
    if (flags.json) {
      ui.json({
        target,
        identity: identity ? publicIdentity(identity) : null,
        pane,
      });
      return;
    }
    console.log(`Pane: ${pane.id}${pane.target ? ` (${pane.target})` : ''}`);
    console.log(`CWD:  ${pane.cwd ?? '-'}`);
    console.log(`CMD:  ${pane.command || '-'}`);
    if (identity) ui.table(['NAME', 'PANE'], [[identity.name, pane.id]]);
    else ui.info('Pane has no active global identity.');
    return;
  }

  const identities = sortedGlobalIdentities(tmux);
  const panes = new Map(tmux.listPanes().map((pane) => [pane.id, pane]));

  if (flags.json) {
    ui.json({
      identities: identities.map((identity) => {
        const pane = paneDetails(ctx, identity.paneId, panes);
        return {
          ...publicIdentity(identity),
          pane: identity.paneId,
          ...(pane.target && { target: pane.target }),
          ...(pane.cwd && { cwd: pane.cwd }),
          command: pane.command,
        };
      }),
    });
    return;
  }

  if (identities.length === 0) {
    ui.info("No active identities found. Use 'tmt name <global-name>' to register one.");
    return;
  }

  ui.table(
    ['NAME', 'PANE', 'TARGET', 'CWD', 'COMMAND'],
    identities.map((identity) => {
      const pane = paneDetails(ctx, identity.paneId, panes);
      return [identity.name, pane.id, pane.target ?? '-', pane.cwd ?? '-', pane.command || '-'];
    })
  );
}
