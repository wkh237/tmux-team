import type { BindingResult } from './types.js';

export interface ValidatedName {
  readonly name: string;
  readonly canonicalName: string;
}

const paneTargetPatterns = [/^%\d+$/, /^\d+\.\d+$/, /^[^\s:]+:\d+\.\d+$/];

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || codePoint === 0x7f;
  });
}

export function normalizeName(name: string): string {
  return name.trim().normalize('NFKC').toLowerCase();
}

export function validateName(name: string): BindingResult<ValidatedName> {
  const trimmed = name.trim();
  const canonicalName = normalizeName(name);
  if (!trimmed || hasControlCharacter(trimmed)) {
    return {
      ok: false,
      error: {
        code: 'INVALID_NAME',
        message: 'Identity name must not be empty or contain control characters.',
      },
    };
  }
  if (paneTargetPatterns.some((pattern) => pattern.test(canonicalName))) {
    return {
      ok: false,
      error: {
        code: 'INVALID_NAME',
        message: 'Identity name must not look like a pane target.',
      },
    };
  }
  return { ok: true, value: { name: trimmed, canonicalName } };
}
