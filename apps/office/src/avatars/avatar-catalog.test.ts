import { describe, expect, it } from 'vitest';
import vectors from '../../../../contracts/office/avatar-pack-vectors.json';
import {
  avatarOptions,
  decodeAvatarCatalog,
  resolveAvatar,
  validAvatarReference,
} from './avatar-catalog.js';

const digest = `sha256:${'1'.repeat(64)}`;
const source = {
  catalogRevision: 1,
  packs: [{ digest, pack: vectors.packCases[0]!.value }],
};

describe('avatar catalog', () => {
  it('decodes bounded packs and resolves one immutable selection', () => {
    const catalog = decodeAvatarCatalog(source);
    const ref = `${digest}/signal-bot`;
    expect(avatarOptions(catalog)).toEqual([{ ref, label: 'Signal bots · Signal bot' }]);
    expect(resolveAvatar(ref, catalog)).toMatchObject({
      status: 'available',
      ref,
      art: { palette: ['#00000000', '#ffffffff'] },
    });
    expect(resolveAvatar(undefined, catalog)).toEqual({ status: 'default' });
    expect(resolveAvatar(`${digest}/missing`, catalog)).toEqual({
      status: 'unavailable',
      ref: `${digest}/missing`,
    });
  });

  it('rejects malformed references, duplicate packs and catalog overflow', () => {
    expect(validAvatarReference(`${digest}/signal-bot`)).toBe(true);
    expect(validAvatarReference(`${digest}/Signal`)).toBe(false);
    expect(() =>
      decodeAvatarCatalog({ ...source, packs: [...source.packs, ...source.packs] })
    ).toThrow();
    expect(() =>
      decodeAvatarCatalog({
        catalogRevision: 1,
        packs: Array.from({ length: 65 }, (_, index) => ({
          digest: `sha256:${index.toString(16).padStart(64, '0')}`,
          pack: vectors.packCases[0]!.value,
        })),
      })
    ).toThrow();
  });
});
