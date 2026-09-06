import { validateExactText } from './exact-text.js';

/** Original request text is bounded independently from injected transport text. */
export const MAX_REQUEST_CONTENT_BYTES = 1024 * 1024;

export type RequestInputErrorCode = 'REQUEST_INPUT_INVALID' | 'REQUEST_INPUT_TOO_LARGE';

export class RequestInputError extends Error {
  readonly code: RequestInputErrorCode;

  constructor(code: RequestInputErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RequestInputError';
    this.code = code;
  }
}

export interface ValidatedRequestMessage {
  readonly message: string;
  readonly messageBytes: number;
}

/** Validate and measure an exact text payload without normalizing its contents. */
export function validateRequestMessage(value: unknown): ValidatedRequestMessage {
  const validated = validateExactText(value, MAX_REQUEST_CONTENT_BYTES);
  if (!validated.ok) {
    throw new RequestInputError(
      validated.issue === 'TOO_LARGE' ? 'REQUEST_INPUT_TOO_LARGE' : 'REQUEST_INPUT_INVALID',
      validated.issue === 'TOO_LARGE'
        ? `Request message must not exceed ${MAX_REQUEST_CONTENT_BYTES} UTF-8 bytes.`
        : 'Request message must be a string containing well-formed Unicode.'
    );
  }
  return { message: validated.text, messageBytes: validated.bytes };
}
