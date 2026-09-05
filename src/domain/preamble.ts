import type { DurableIdentity } from './identity.js';
import { normalizeTextContent, TextContentValidationError } from './text-content.js';

export interface PreambleProfile {
  readonly content: string;
  readonly updatedAt: string;
}

export interface PreambleResult {
  readonly identity: DurableIdentity;
  readonly preamble: PreambleProfile | null;
}

export type StoredPreambleResult = PreambleResult & {
  readonly preamble: PreambleProfile;
};

export type PreambleContentErrorCode = 'PREAMBLE_INPUT_INVALID' | 'PREAMBLE_INPUT_TOO_LARGE';

export class PreambleContentError extends Error {
  constructor(
    public readonly code: PreambleContentErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'PreambleContentError';
  }
}

export function normalizePreambleContent(value: string): string {
  try {
    return normalizeTextContent(value);
  } catch (error) {
    if (!(error instanceof TextContentValidationError)) throw error;
    if (error.issue === 'TOO_LARGE') {
      throw new PreambleContentError(
        'PREAMBLE_INPUT_TOO_LARGE',
        'Preamble content must not exceed 65536 bytes.'
      );
    }
    throw new PreambleContentError(
      'PREAMBLE_INPUT_INVALID',
      error.issue === 'EMPTY'
        ? 'Preamble content must not be empty or whitespace-only.'
        : error.issue === 'CONTROL'
          ? 'Preamble content must not contain control characters.'
          : 'Preamble content must be valid Unicode and must not contain control characters.'
    );
  }
}
