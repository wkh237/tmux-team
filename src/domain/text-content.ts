export const MAX_CONTENT_BYTES = 65_536;

export type TextContentIssue = 'TOO_LARGE' | 'INVALID_UNICODE' | 'CONTROL' | 'EMPTY';

export class TextContentValidationError extends Error {
  constructor(
    public readonly issue: TextContentIssue,
    message: string
  ) {
    super(message);
    this.name = 'TextContentValidationError';
  }
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0xd800 || code > 0xdfff) continue;
    if (code >= 0xdc00 || index + 1 >= value.length) return true;
    const next = value.charCodeAt(index + 1);
    if (next < 0xdc00 || next > 0xdfff) return true;
    index += 1;
  }
  return false;
}

function hasForbiddenControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f) return true;
  }
  return false;
}

/** Normalize bounded user text while preserving meaningful whitespace. */
export function normalizeTextContent(value: string): string {
  if (Buffer.byteLength(value, 'utf8') > MAX_CONTENT_BYTES) {
    throw new TextContentValidationError('TOO_LARGE', 'Content must not exceed 65536 bytes.');
  }
  if (hasLoneSurrogate(value)) {
    throw new TextContentValidationError(
      'INVALID_UNICODE',
      'Content must be valid Unicode and must not contain control characters.'
    );
  }

  let normalized = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  if (normalized.startsWith('\ufeff')) normalized = normalized.slice(1);
  if (hasForbiddenControl(normalized)) {
    throw new TextContentValidationError('CONTROL', 'Content must not contain control characters.');
  }
  if (!normalized.trim()) {
    throw new TextContentValidationError('EMPTY', 'Content must not be empty or whitespace-only.');
  }
  if (Buffer.byteLength(normalized, 'utf8') > MAX_CONTENT_BYTES) {
    throw new TextContentValidationError('TOO_LARGE', 'Content must not exceed 65536 bytes.');
  }
  return normalized;
}
