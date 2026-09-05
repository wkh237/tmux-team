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

export type ReplyRequest = {
  readonly kind: 'reply';
  readonly requestId: string;
  readonly receipt: string;
} & (
  | { readonly file: string; readonly stdin?: never }
  | { readonly file?: never; readonly stdin: true }
);

export type ResultRequest = {
  readonly kind: 'result';
  readonly requestId: string;
};
