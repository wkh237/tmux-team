import { describe, expect, it } from 'vitest';
import vectors from '../../../../contracts/office/block-v1.vectors.json' with { type: 'json' };
import {
  footprint,
  sameLayout,
  validFurniture,
  validLayout,
  encodeLayout,
  decodeLayout,
} from './block-contract.js';

describe('bounded decoration contract', () => {
  it.each(vectors)('$name', ({ valid, item, stored }) => {
    expect(validFurniture(item)).toBe(valid);
    expect(validLayout([item])).toBe(valid);
    if (validFurniture(item)) {
      expect(encodeLayout([item])).toEqual([stored]);
      expect(decodeLayout([stored])).toEqual([item]);
    } else expect(() => decodeLayout([stored])).toThrow();
  });
  it('checks the last slot, the budget and empty layouts', () => {
    const item = { asset: 'desk', x: 0, y: 0, rotation: 0 };
    expect(validLayout([])).toBe(true);
    expect(validLayout(Array(16).fill(item))).toBe(true);
    expect(validLayout([...Array(15).fill(item), { ...item, x: 32 }])).toBe(false);
    expect(validLayout(Array(17).fill(item))).toBe(false);
    expect(validLayout(Array(16))).toBe(false);
  });
  it('uses the rotated footprint for rendering', () => {
    expect(footprint({ asset: 'rug', x: 0, y: 0, rotation: 1 })).toEqual({ width: 4, height: 6 });
  });
  it('equality preserves paint order but ignores JSON key order', () => {
    const first = { asset: 'desk' as const, x: 0, y: 0, rotation: 0 };
    const second = { asset: 'rug' as const, x: 0, y: 0, rotation: 0 };
    expect(sameLayout([first], [{ rotation: 0, y: 0, x: 0, asset: 'desk' }])).toBe(true);
    expect(sameLayout([first, second], [second, first])).toBe(false);
  });
});
