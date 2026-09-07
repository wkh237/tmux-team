export type PaneMetadataStage = 'read' | 'write';

function failureSummary(cause: unknown): string {
  if (!(cause instanceof Error)) return '';
  // Never expose subprocess stderr, argv or metadata JSON in public errors.
  const code = Object.getOwnPropertyDescriptor(cause, 'code')?.value;
  if (['EACCES', 'EPERM', 'ENOENT', 'ETIMEDOUT', 'ENOBUFS'].includes(code)) {
    return ` (${code})`;
  }
  const status = Object.getOwnPropertyDescriptor(cause, 'status')?.value;
  if (Number.isInteger(status) && status > 0 && status <= 255) {
    return ` (tmux exit ${status})`;
  }
  const signal = Object.getOwnPropertyDescriptor(cause, 'signal')?.value;
  if (signal === 'SIGKILL' || signal === 'SIGTERM') return ` (${signal})`;
  return '';
}

/** Safe adapter failure detail shared with the identity application boundary. */
export class PaneMetadataError extends Error {
  constructor(
    readonly stage: PaneMetadataStage,
    options?: { readonly cause?: unknown }
  ) {
    super(`Could not ${stage} pane metadata${failureSummary(options?.cause)}.`, options);
    this.name = 'PaneMetadataError';
  }
}
