import { describe, expect, it } from 'vitest';
import vectors from '../../../../contracts/office/avatar-pack-vectors.json';
import { decodeAvatarPack } from './avatar-contract.js';

describe('avatar-pack projection', () => {
  it('matches the shared literal vectors', () => {
    for (const testCase of vectors.packCases) {
      if (testCase.valid)
        expect(() => decodeAvatarPack(testCase.value), testCase.name).not.toThrow();
      else expect(() => decodeAvatarPack(testCase.value), testCase.name).toThrow();
    }
  });

  it('rejects unknown fields and unresolved indices', () => {
    const source = structuredClone(vectors.packCases[0]!.value) as Record<string, unknown>;
    expect(() => decodeAvatarPack({ ...source, extra: true })).toThrow();
    const avatars = structuredClone(source.avatars) as Array<Record<string, unknown>>;
    avatars[0]!.pixels = Array.from({ length: 24 }, () => '2222222222222222');
    expect(() => decodeAvatarPack({ ...source, avatars })).toThrow();
    expect(() => decodeAvatarPack({ ...source, label: '\ud800' })).toThrow();
    expect(() => decodeAvatarPack({ ...source, label: 'friendly 🤖' })).not.toThrow();
  });

  it('admits the exact 16-avatar and 6,144-cell capacity', () => {
    const source = structuredClone(vectors.packCases[0]!.value);
    source.avatars = Array.from({ length: 16 }, (_, index) => ({
      ...structuredClone(source.avatars[0]!),
      key: `bot-${index}`,
    }));
    expect(decodeAvatarPack(source).avatars).toHaveLength(16);
    source.avatars.push({ ...structuredClone(source.avatars[0]!), key: 'one-more' });
    expect(() => decodeAvatarPack(source)).toThrow();
  });
});
