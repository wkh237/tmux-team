// ─────────────────────────────────────────────────────────────
// list command - show active global identities and pane status
// ─────────────────────────────────────────────────────────────

import type { Context, PaneInfo } from '../types.js';
import { ExitCodes } from '../exits.js';
import { resolveTarget, sortedGlobalIdentities } from '../target-resolver.js';
import { normalizeName } from '../domain/names.js';
import { identityAwareTmux } from '../identity-service.js';

type PublicIdentity = { name: string; canonicalName: string };

function publicIdentity(identity: PublicIdentity): PublicIdentity {
  return {
    name: identity.name,
    canonicalName: identity.canonicalName || normalizeName(identity.name),
  };
}

function paneDetails(paneId: string, pane?: PaneInfo) {
  return {
    id: paneId,
    ...(pane?.target && { target: pane.target }),
    ...(pane?.cwd && { cwd: pane.cwd }),
    command: pane?.command ?? '',
  };
}

export function cmdList(ctx: Context, target?: string): void {
  const { ui, tmux, flags, exit } = ctx;
  const runtimeTmux = identityAwareTmux(tmux, ctx.identityService);

  if (target !== undefined) {
    const resolution = resolveTarget(runtimeTmux, target);
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
    const paneId = resolution.value.paneId;
    const observedPane =
      identity?.pane ??
      tmux.getEndpointSnapshot?.({ paneIds: [paneId] }).panes.find((pane) => pane.id === paneId);
    if (!observedPane) throw new Error('Resolved pane evidence is unavailable.');
    const pane = paneDetails(paneId, observedPane);
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

  const identities = sortedGlobalIdentities(runtimeTmux);

  if (flags.json) {
    ui.json({
      identities: identities.map((identity) => {
        const pane = paneDetails(identity.paneId, identity.pane);
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
      const pane = paneDetails(identity.paneId, identity.pane);
      return [identity.name, pane.id, pane.target ?? '-', pane.cwd ?? '-', pane.command || '-'];
    })
  );
}
