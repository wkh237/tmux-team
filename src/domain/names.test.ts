import { describe, expect, it } from 'vitest';
import { isPaneTarget, normalizeName, validateName } from './names.js';

describe('identity name validation', () => {
  it('normalizes Unicode and surrounding whitespace deterministically', () => {
    expect(normalizeName(' Ａlice ')).toBe('alice');
  });

  it.each([
    '',
    '  ',
    'a\u0000b',
    '%14',
    '10.3',
    'session:2.1',
    '％１４',
    '１０.３',
    'session：２.１',
  ])('rejects invalid or pane-shaped name %j', (name) => {
    expect(validateName(name).ok).toBe(false);
  });

  it('recognizes only supported pane target forms', () => {
    expect(isPaneTarget('%14')).toBe(true);
    expect(isPaneTarget('10.3')).toBe(true);
    expect(isPaneTarget('session:2.1')).toBe(true);
    expect(isPaneTarget('backend')).toBe(false);
  });
});
