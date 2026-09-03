import type { ActiveRegistration } from './domain/types.js';
import type { DurableIdentity } from './domain/identity.js';
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

export type DurableIdentityResolution =
  | { readonly status: 'bound'; readonly identity: DurableIdentity }
  | { readonly status: 'not-found' }
  | { readonly status: 'required' }
  | { readonly status: 'ambiguous' };

export type IdentitySelectionErrorCode =
  | 'NAME_NOT_FOUND'
  | 'IDENTITY_REQUIRED'
  | 'IDENTITY_AMBIGUOUS';

export class IdentitySelectionError extends Error {
  constructor(
    public readonly code: IdentitySelectionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'IdentitySelectionError';
  }
}

export interface DurableIdentityContext {
  readonly findByCanonicalName: (canonicalName: string) => DurableIdentity | undefined;
  readonly currentIdentity: () =>
    | { readonly identity: DurableIdentity }
    | { readonly status: 'ambiguous' }
    | undefined;
}

/** Shared selector boundary for durable explicit and verified implicit identity access. */
export function resolveDurableIdentity(
  context: DurableIdentityContext,
  selector?: IdentitySelector
): DurableIdentityResolution {
  if (selector) {
    const identity = context.findByCanonicalName(normalizeName(selector.value));
    return identity ? { status: 'bound', identity } : { status: 'not-found' };
  }
  const current = context.currentIdentity();
  if (current && 'status' in current && current.status === 'ambiguous') {
    return { status: 'ambiguous' };
  }
  if (!current || 'status' in current) return { status: 'required' };
  return { status: 'bound', identity: current.identity };
}

export function requireDurableIdentity(
  context: DurableIdentityContext,
  selector?: IdentitySelector
): DurableIdentity {
  const resolution = resolveDurableIdentity(context, selector);
  if (resolution.status === 'not-found') {
    throw new IdentitySelectionError(
      'NAME_NOT_FOUND',
      `Identity '${selector?.value}' was not found.`
    );
  }
  if (resolution.status === 'required') {
    throw new IdentitySelectionError(
      'IDENTITY_REQUIRED',
      'An identity is required; use --identity or run from a verified bound pane.'
    );
  }
  if (resolution.status === 'ambiguous') {
    throw new IdentitySelectionError(
      'IDENTITY_AMBIGUOUS',
      'Current pane has ambiguous identity binding.'
    );
  }
  return resolution.identity;
}
