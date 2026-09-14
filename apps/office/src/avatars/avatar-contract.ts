import {
  boundedText,
  exactRecord,
  indexedArtKey,
  INDEXED_ART_LIMITS,
  indexedLicense,
  indexedPalette,
  indexedRaster,
} from '../rendering/indexed-art-contract.js';

export interface AvatarDefinition {
  key: string;
  label: string;
  pixels: string[];
}

export interface AvatarPack {
  formatVersion: 1;
  label: string;
  credit: string;
  license: string;
  palette: string[];
  avatars: AvatarDefinition[];
}

export interface CatalogAvatarPack {
  digest: string;
  pack: AvatarPack;
}

export function decodeAvatarPack(value: unknown): AvatarPack {
  const object = exactRecord(
    value,
    ['formatVersion', 'label', 'credit', 'license', 'palette', 'avatars'],
    'avatar pack'
  );
  const palette = object.palette;
  if (
    object.formatVersion !== 1 ||
    !boundedText(object.label, INDEXED_ART_LIMITS.labelBytes) ||
    !boundedText(object.credit, INDEXED_ART_LIMITS.creditBytes) ||
    !indexedLicense(object.license) ||
    !indexedPalette(palette) ||
    !Array.isArray(object.avatars) ||
    object.avatars.length < 1 ||
    object.avatars.length > 16
  )
    throw new Error('Invalid avatar pack values.');
  const keys = new Set<string>();
  let cellCount = 0;
  const avatars = object.avatars.map((value) => {
    const avatar = exactRecord(value, ['key', 'label', 'pixels'], 'avatar definition');
    if (
      !indexedArtKey(avatar.key) ||
      keys.has(avatar.key) ||
      !boundedText(avatar.label, INDEXED_ART_LIMITS.labelBytes)
    )
      throw new Error('Invalid avatar definition.');
    keys.add(avatar.key);
    const pixels = indexedRaster(avatar.pixels, palette.length, {
      width: 16,
      height: 24,
      maxSide: 24,
      maxCells: 384,
    });
    if (!pixels || !pixels.some((row) => /[1-9a-f]/.test(row)))
      throw new Error('Invalid avatar pixels.');
    cellCount += 384;
    return { key: avatar.key, label: avatar.label, pixels };
  });
  if (cellCount > 6144) throw new Error('Avatar pack cells exceed their bound.');
  return {
    formatVersion: 1,
    label: object.label,
    credit: object.credit,
    license: object.license,
    palette,
    avatars,
  };
}
