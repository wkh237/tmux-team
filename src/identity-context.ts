import type { ActiveRegistration } from './domain/types.js';
import { normalizeName } from './domain/names.js';

/** A parsed target. `explicit` is true only when --identity was used. */
export interface IdentitySelector {
  readonly value: string;
  readonly kind: 'identity' | 'pane';
  readonly explicit?: boolean;
}

export interface IdentityContext {
  readonly currentPaneId: string | null;
  readonly registrations: readonly ActiveRegistration[];
}

export type IdentityResolution =
  | { readonly status: 'bound'; readonly registration: ActiveRegistration }
  | { readonly status: 'unbound' }
  | { readonly status: 'not-found' }
  | { readonly status: 'outside-tmux' }
  | { readonly status: 'ambiguous'; readonly registrations: readonly ActiveRegistration[] };

/** Resolve an explicitly selected identity or the one identity bound to the current pane. */
export function resolveIdentityContext(
  context: IdentityContext,
  selector?: IdentitySelector
): IdentityResolution {
  if (selector) {
    const normalized = normalizeName(selector.value);
    const matches = context.registrations.filter(
      (registration) =>
        normalizeName(registration.name) === normalized ||
        normalizeName(registration.canonicalName) === normalized
    );
    if (matches.length === 1) return { status: 'bound', registration: matches[0] };
    if (matches.length > 1) return { status: 'ambiguous', registrations: matches };
    return { status: 'not-found' };
  }

  if (!context.currentPaneId) return { status: 'outside-tmux' };
  const matches = context.registrations.filter(
    (registration) => registration.paneId === context.currentPaneId
  );
  if (matches.length === 1) return { status: 'bound', registration: matches[0] };
  if (matches.length > 1) return { status: 'ambiguous', registrations: matches };
  return { status: 'unbound' };
}
