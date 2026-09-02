export interface ActiveRegistration {
  readonly name: string;
  readonly canonicalName: string;
  readonly paneId: string;
}

export type BindingErrorCode =
  | 'INVALID_NAME'
  | 'PANE_ALREADY_BOUND'
  | 'NAME_ALREADY_ACTIVE'
  | 'UNBOUND_PANE';

export interface BindingError {
  readonly code: BindingErrorCode;
  readonly message: string;
}

export type BindingResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: BindingError };
