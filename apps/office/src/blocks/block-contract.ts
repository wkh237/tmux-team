import { BUILTIN_DIGEST, BUILTIN_PACK } from '../props/prop-contract.js';
import type { CatalogPack, Footprint } from '../props/prop-contract.js';
import { validImmutableArtReference } from '../rendering/immutable-art-reference.js';

export const BLOCK_SIZE = 32;
export const OBJECT_LIMIT = 16;
export const FURNITURE = {
  desk: { label: 'Desk', code: 'd', width: 4, height: 2 },
  chair: { label: 'Chair', code: 'c', width: 2, height: 2 },
  plant: { label: 'Plant', code: 'p', width: 2, height: 2 },
  rug: { label: 'Rug', code: 'r', width: 6, height: 4 },
} as const;
export type Asset = keyof typeof FURNITURE;
export interface Furniture {
  prop: string;
  footprint: Footprint;
  x: number;
  y: number;
  rotation: number;
}
export interface Block {
  revision: number;
  objects: Furniture[];
  updatedAtMs: number;
  catalog?: CatalogPack[];
}

export function builtinFurniture(asset: Asset, x: number, y: number, rotation: number): Furniture {
  const definition = FURNITURE[asset];
  return {
    prop: `${BUILTIN_DIGEST}/${asset}`,
    footprint: { width: definition.width, height: definition.height },
    x,
    y,
    rotation,
  };
}

export function footprint(item: Furniture): Footprint {
  const { width, height } = item.footprint;
  return item.rotation % 2 ? { width: height, height: width } : { width, height };
}

export function validFurniture(value: unknown): value is Furniture {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).length !== 5 ||
    !['prop', 'footprint', 'x', 'y', 'rotation'].every((field) => Object.hasOwn(item, field)) ||
    !validImmutableArtReference(item.prop) ||
    !item.footprint ||
    typeof item.footprint !== 'object' ||
    Array.isArray(item.footprint) ||
    Object.keys(item.footprint as object).length !== 2 ||
    !Object.hasOwn(item.footprint as object, 'width') ||
    !Object.hasOwn(item.footprint as object, 'height') ||
    !Number.isInteger((item.footprint as Record<string, unknown>).width) ||
    !Number.isInteger((item.footprint as Record<string, unknown>).height) ||
    !Number.isInteger(item.x) ||
    !Number.isInteger(item.y) ||
    !Number.isInteger(item.rotation)
  )
    return false;
  const furniture = item as unknown as Furniture;
  if (
    furniture.footprint.width < 1 ||
    furniture.footprint.width > 8 ||
    furniture.footprint.height < 1 ||
    furniture.footprint.height > 8
  )
    return false;
  const size = footprint(furniture);
  return (
    furniture.rotation >= 0 &&
    furniture.rotation <= 3 &&
    furniture.x >= 0 &&
    furniture.y >= 0 &&
    furniture.x + size.width <= BLOCK_SIZE &&
    furniture.y + size.height <= BLOCK_SIZE
  );
}

export function validLayout(value: unknown): value is Furniture[] {
  return (
    Array.isArray(value) && value.length <= OBJECT_LIMIT && Array.from(value).every(validFurniture)
  );
}

export function sameLayout(left: Furniture[], right: Furniture[]): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const other = right[index];
      return (
        item.prop === other?.prop &&
        item.footprint.width === other.footprint.width &&
        item.footprint.height === other.footprint.height &&
        item.x === other.x &&
        item.y === other.y &&
        item.rotation === other.rotation
      );
    })
  );
}

function builtinAsset(item: Furniture): Asset | undefined {
  if (!item.prop.startsWith(`${BUILTIN_DIGEST}/`)) return undefined;
  const key = item.prop.slice(BUILTIN_DIGEST.length + 1) as Asset;
  const definition = FURNITURE[key];
  return definition &&
    item.footprint.width === definition.width &&
    item.footprint.height === definition.height
    ? key
    : undefined;
}

/** Remote v1 storage-only encoding. Local storage is canonical v2 JSON. */
export function encodeLayout(objects: Furniture[]): string[] {
  if (!validLayout(objects)) throw new Error('Invalid block layout.');
  return objects.map((item) => {
    const asset = builtinAsset(item);
    if (!asset) throw new Error('Remote blocks support only built-in props.');
    return `${FURNITURE[asset].code}${item.rotation}${item.x.toString(32)}${item.y.toString(32)}`;
  });
}

export function decodeLayout(value: unknown): Furniture[] {
  if (!Array.isArray(value) || value.length > OBJECT_LIMIT)
    throw new Error('Invalid stored layout.');
  const objects = value.map((token) => {
    if (typeof token !== 'string' || !/^[dcpr][0-3][0-9a-v]{2}$/.test(token))
      throw new Error('Invalid stored furniture.');
    const asset = (Object.keys(FURNITURE) as Asset[]).find(
      (key) => FURNITURE[key].code === token[0]
    );
    if (!asset) throw new Error('Invalid stored furniture.');
    return builtinFurniture(
      asset,
      Number.parseInt(token[2]!, 32),
      Number.parseInt(token[3]!, 32),
      Number(token[1])
    );
  });
  if (!validLayout(objects)) throw new Error('Invalid stored footprint.');
  return objects;
}

export function defaultCatalog(): CatalogPack[] {
  return [{ digest: BUILTIN_DIGEST, pack: BUILTIN_PACK }];
}

export class BlockConflict extends Error {
  constructor() {
    super('The block changed. Load the latest layout before editing again.');
  }
}
export interface BlockPort {
  watch(worldId: string, changed: (block: Block | null) => void, failed: () => void): () => void;
  apply(worldId: string, revision: number, objects: Furniture[]): Promise<Block>;
}
