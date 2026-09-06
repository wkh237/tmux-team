import { hasLoneSurrogate } from './text-content.js';

export type ExactTextIssue = 'INVALID' | 'TOO_LARGE';

export type ExactTextValidation =
  | { readonly ok: true; readonly text: string; readonly bytes: number }
  | { readonly ok: false; readonly issue: ExactTextIssue };

/** Validate and measure exact text without assigning feature-specific errors. */
export function validateExactText(value: unknown, maxBytes: number): ExactTextValidation {
  if (typeof value !== 'string' || hasLoneSurrogate(value)) {
    return { ok: false, issue: 'INVALID' };
  }
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > maxBytes) return { ok: false, issue: 'TOO_LARGE' };
  return { ok: true, text: value, bytes };
}
