import type { IdentitySelector } from '../identity-context.js';

export type RoleRequest = {
  readonly kind: 'role';
  readonly selector?: IdentitySelector;
} & (
  | { readonly operation: 'show' }
  | { readonly operation: 'clear' }
  | { readonly operation: 'set'; readonly content: string; readonly file?: never }
  | { readonly operation: 'set'; readonly file: string; readonly content?: never }
);
