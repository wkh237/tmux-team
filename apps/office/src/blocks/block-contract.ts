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
  asset: Asset;
  x: number;
  y: number;
  rotation: number;
}
export interface Block {
  revision: number;
  objects: Furniture[];
  updatedAtMs: number;
}
export function footprint(item: Furniture): { width: number; height: number } {
  const { width, height } = FURNITURE[item.asset];
  return item.rotation % 2 ? { width: height, height: width } : { width, height };
}
export function validFurniture(value: unknown): value is Furniture {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).length !== 4 ||
    !Object.keys(item).every((key) => ['asset', 'x', 'y', 'rotation'].includes(key)) ||
    typeof item.asset !== 'string' ||
    !Object.hasOwn(FURNITURE, item.asset) ||
    !Number.isInteger(item.x) ||
    !Number.isInteger(item.y) ||
    !Number.isInteger(item.rotation)
  )
    return false;
  const furniture = item as unknown as Furniture;
  const { width, height } = footprint(furniture);
  return (
    furniture.rotation >= 0 &&
    furniture.rotation <= 3 &&
    furniture.x >= 0 &&
    furniture.y >= 0 &&
    furniture.x + width <= BLOCK_SIZE &&
    furniture.y + height <= BLOCK_SIZE
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
        item.asset === other.asset &&
        item.x === other.x &&
        item.y === other.y &&
        item.rotation === other.rotation
      );
    })
  );
}

/** Storage-only encoding: asset, quarter turn, base-32 X, base-32 Y.
 * Public views/commands retain named fields; one codec owns this representation.
 */
export function encodeLayout(objects: Furniture[]): string[] {
  if (!validLayout(objects)) throw new Error('Invalid block layout.');
  return objects.map(
    (item) =>
      `${FURNITURE[item.asset].code}${item.rotation}${item.x.toString(32)}${item.y.toString(32)}`
  );
}
export function decodeLayout(value: unknown): Furniture[] {
  if (!Array.isArray(value) || value.length > OBJECT_LIMIT)
    throw new Error('Invalid stored layout.');
  const objects = Array.from(value, (token) => {
    if (typeof token !== 'string' || !/^[dcpr][0-3][0-9a-v]{2}$/.test(token))
      throw new Error('Invalid stored furniture.');
    const asset = (Object.keys(FURNITURE) as Asset[]).find(
      (key) => FURNITURE[key].code === token[0]
    )!;
    return {
      asset,
      rotation: Number(token[1]),
      x: parseInt(token[2], 32),
      y: parseInt(token[3], 32),
    };
  });
  if (!validLayout(objects)) throw new Error('Invalid stored footprint.');
  return objects;
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
