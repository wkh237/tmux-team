// Shared target resolution for commands that address one pane.

import { isPaneTarget, normalizeName } from './domain/names.js';
import type { ActiveRegistration } from './domain/types.js';
import type { Tmux } from './types.js';

export interface ResolvedTarget {
  readonly input: string;
  readonly paneId: string;
  readonly identity?: ActiveRegistration;
  readonly kind: 'pane' | 'identity';
}

export type TargetResolutionErrorCode = 'PANE_NOT_FOUND' | 'NAME_NOT_FOUND';

export interface TargetResolutionError {
  readonly code: TargetResolutionErrorCode;
  readonly message: string;
}

export type TargetResolution =
  | { readonly ok: true; readonly value: ResolvedTarget }
  | { readonly ok: false; readonly error: TargetResolutionError };

/**
 * Resolve a pane-shaped argument before looking at names.  This ordering is
 * intentional: a stale pane target must never be interpreted as an identity
 * name, even if a registration happens to use the same text in old metadata.
 */
export function resolveTarget(tmux: Tmux, input: string): TargetResolution {
  if (isPaneTarget(input)) {
    const paneId = tmux.resolvePaneTarget(input);
    if (!paneId) {
      return {
        ok: false,
        error: {
          code: 'PANE_NOT_FOUND',
          message: `Pane target '${input}' was not found.`,
        },
      };
    }
    const identity = tmux
      .listGlobalIdentities()
      .filter((entry) => entry.paneId === paneId)
      .sort(
        (a, b) =>
          normalizeName(a.canonicalName || a.name).localeCompare(
            normalizeName(b.canonicalName || b.name)
          ) || a.name.localeCompare(b.name)
      )[0];
    return {
      ok: true,
      value: { input, paneId, kind: 'pane', ...(identity && { identity }) },
    };
  }

  const canonical = normalizeName(input);
  const identity = tmux
    .listGlobalIdentities()
    .filter(
      (entry) =>
        (entry.canonicalName && entry.canonicalName === canonical) ||
        normalizeName(entry.name) === canonical
    )
    .sort(
      (a, b) =>
        a.paneId.localeCompare(b.paneId) ||
        normalizeName(a.canonicalName || a.name).localeCompare(
          normalizeName(b.canonicalName || b.name)
        ) ||
        a.name.localeCompare(b.name)
    )[0];

  if (!identity) {
    return {
      ok: false,
      error: {
        code: 'NAME_NOT_FOUND',
        message: `Identity '${input}' is not active.`,
      },
    };
  }

  return {
    ok: true,
    value: { input, paneId: identity.paneId, identity, kind: 'identity' },
  };
}

export function sortedGlobalIdentities(tmux: Tmux): ActiveRegistration[] {
  return [...tmux.listGlobalIdentities()].sort(
    (a, b) =>
      normalizeName(a.canonicalName || a.name).localeCompare(
        normalizeName(b.canonicalName || b.name)
      ) ||
      a.paneId.localeCompare(b.paneId) ||
      a.name.localeCompare(b.name)
  );
}
