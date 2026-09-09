import { describe, expect, it } from 'vitest';
import { validWorldName } from './world-contract.js';

describe('world name feedback', () => {
  it.each(['', ' ', '\u00a0', '\u3000', '\ud800', 'line\nbreak', 'x'.repeat(81), '😀'.repeat(81)])(
    'rejects invalid name %j',
    (name) => {
      expect(validWorldName(name)).toBe(false);
    }
  );
  it.each(['My office', 'x'.repeat(80), '😀'.repeat(80)])('accepts valid name %j', (name) => {
    expect(validWorldName(name)).toBe(true);
  });
});
