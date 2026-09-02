import type { BindingResult } from './types.js';

export interface ValidatedName {
  readonly name: string;
  readonly canonicalName: string;
}

// Keep pane-target recognition in the domain layer so command resolvers and
// name validation cannot drift apart.  These are the target forms accepted by
// tmux-team; the tmux wrapper remains responsible for resolving them to a
// stable `%pane_id`.
const paneTargetPatterns = [/^%\d+$/, /^\d+\.\d+$/, /^[^\s:]+:\d+\.\d+$/];

export function isPaneTarget(value: string): boolean {
  const canonical = normalizeName(value);
  return paneTargetPatterns.some((pattern) => pattern.test(canonical));
}

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
  if (isPaneTarget(canonicalName)) {
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
