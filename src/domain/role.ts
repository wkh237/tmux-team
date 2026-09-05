import {
  MAX_CONTENT_BYTES,
  normalizeTextContent,
  TextContentValidationError,
} from './text-content.js';

export const MAX_ROLE_BYTES = MAX_CONTENT_BYTES;

export type RoleContentErrorCode = 'ROLE_INPUT_INVALID' | 'ROLE_INPUT_TOO_LARGE';

export class RoleContentError extends Error {
  constructor(
    public readonly code: RoleContentErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'RoleContentError';
  }
}

/** Normalize and validate role content while preserving meaningful whitespace. */
export function normalizeRoleContent(value: string): string {
  try {
    return normalizeTextContent(value);
  } catch (error) {
    if (!(error instanceof TextContentValidationError)) throw error;
    if (error.issue === 'TOO_LARGE') {
      throw new RoleContentError(
        'ROLE_INPUT_TOO_LARGE',
        'Role content must not exceed 65536 bytes.'
      );
    }
    if (error.issue === 'EMPTY') {
      throw new RoleContentError(
        'ROLE_INPUT_INVALID',
        'Role content must not be empty or whitespace-only.'
      );
    }
    if (error.issue === 'CONTROL') {
      throw new RoleContentError(
        'ROLE_INPUT_INVALID',
        'Role content must not contain control characters.'
      );
    }
    throw new RoleContentError(
      'ROLE_INPUT_INVALID',
      'Role content must be valid Unicode and must not contain control characters.'
    );
  }
}
