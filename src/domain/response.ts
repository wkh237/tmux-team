import { validateExactText } from './exact-text.js';

/** Final response bodies are bounded independently from role/preamble content. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

export type ResponseErrorCode =
  | 'RESPONSE_INPUT_INVALID'
  | 'RESPONSE_INPUT_TOO_LARGE'
  | 'RESPONSE_REQUEST_NOT_FOUND'
  | 'RESPONSE_ATTEMPT_MISMATCH'
  | 'RESPONSE_RECIPIENT_MISMATCH'
  | 'RESPONSE_STATE_INVALID'
  | 'RESPONSE_CONFLICT'
  | 'RESPONSE_EXPIRED';

export class ResponseError extends Error {
  readonly code: ResponseErrorCode;

  constructor(code: ResponseErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ResponseError';
    this.code = code;
  }
}

export interface ValidatedResponseBody {
  readonly body: string;
  readonly bodyBytes: number;
}

/** Validate without normalizing: final response text is an exact immutable payload. */
export function validateResponseBody(value: unknown): ValidatedResponseBody {
  const validated = validateExactText(value, MAX_RESPONSE_BYTES);
  if (!validated.ok) {
    if (validated.issue === 'TOO_LARGE') {
      throw new ResponseError(
        'RESPONSE_INPUT_TOO_LARGE',
        `Response body must not exceed ${MAX_RESPONSE_BYTES} UTF-8 bytes.`
      );
    }
    throw new ResponseError(
      'RESPONSE_INPUT_INVALID',
      typeof value === 'string'
        ? 'Response body must contain well-formed Unicode.'
        : 'Response body must be a string.'
    );
  }
  return { body: validated.text, bodyBytes: validated.bytes };
}
