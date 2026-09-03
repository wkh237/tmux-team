export const MAX_ROLE_BYTES = 65_536;

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

/** Normalize and validate role content while preserving meaningful whitespace. */
export function normalizeRoleContent(value: string): string {
  if (Buffer.byteLength(value, 'utf8') > MAX_ROLE_BYTES) {
    throw new RoleContentError('ROLE_INPUT_TOO_LARGE', 'Role content must not exceed 65536 bytes.');
  }
  if (hasLoneSurrogate(value)) {
    throw new RoleContentError(
      'ROLE_INPUT_INVALID',
      'Role content must be valid Unicode and must not contain control characters.'
    );
  }
  let normalized = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  if (normalized.startsWith('\ufeff')) normalized = normalized.slice(1);
  if (hasForbiddenControl(normalized)) {
    throw new RoleContentError(
      'ROLE_INPUT_INVALID',
      'Role content must not contain control characters.'
    );
  }
  if (!normalized.trim()) {
    throw new RoleContentError(
      'ROLE_INPUT_INVALID',
      'Role content must not be empty or whitespace-only.'
    );
  }
  if (Buffer.byteLength(normalized, 'utf8') > MAX_ROLE_BYTES) {
    throw new RoleContentError('ROLE_INPUT_TOO_LARGE', 'Role content must not exceed 65536 bytes.');
  }
  return normalized;
}
