export type TmuxDeliveryStage = 'paste' | 'literal' | 'submit';

/** A send reached a stage where the pane may have received user input. */
export class TmuxDeliveryError extends Error {
  readonly code = 'DELIVERY_UNCERTAIN';
  readonly outcome = 'uncertain';

  constructor(
    readonly stage: TmuxDeliveryStage,
    options?: { readonly cause?: unknown }
  ) {
    super(`Message delivery is uncertain during ${stage}.`, options);
    this.name = 'TmuxDeliveryError';
  }
}
