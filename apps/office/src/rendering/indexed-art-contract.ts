/** Pure predicates shared by the two strict indexed-art projections. */
export const INDEXED_ART_LIMITS = {
  keyBytes: 32,
  labelBytes: 80,
  creditBytes: 120,
  licenseBytes: 64,
  paletteEntries: 16,
} as const;
export function exactRecord(
  value: unknown,
  keys: string[],
  label: string
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid ${label}.`);
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(object, key))
  )
    throw new Error(`Invalid ${label} fields.`);
  return object;
}

export function boundedText(value: unknown, maxBytes: number): value is string {
  if (typeof value !== 'string') return false;
  const bytes = new TextEncoder().encode(value).length;
  return (
    bytes >= 1 &&
    bytes <= maxBytes &&
    !Array.from(value).some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || (code >= 0xd800 && code <= 0xdfff);
    })
  );
}

export function indexedLicense(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= INDEXED_ART_LIMITS.licenseBytes &&
    Array.from(value).every(
      (character) =>
        (character >= 'A' && character <= 'Z') ||
        (character >= 'a' && character <= 'z') ||
        (character >= '0' && character <= '9') ||
        character === '.' ||
        character === '+' ||
        character === '-'
    )
  );
}

export function indexedArtKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    new TextEncoder().encode(value).length <= INDEXED_ART_LIMITS.keyBytes &&
    /^[a-z][a-z0-9-]{0,31}$/.test(value)
  );
}

export function indexedPalette(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= INDEXED_ART_LIMITS.paletteEntries &&
    value[0] === '#00000000' &&
    value.slice(1).every((color) => typeof color === 'string' && /^#[0-9a-f]{6}ff$/.test(color))
  );
}

export function indexedRaster(
  value: unknown,
  paletteLength: number,
  limits: { width?: number; height?: number; maxSide: number; maxCells: number }
): string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > limits.maxSide) return;
  if (limits.height !== undefined && value.length !== limits.height) return;
  const width = typeof value[0] === 'string' ? value[0].length : 0;
  if (
    width < 1 ||
    width > limits.maxSide ||
    (limits.width !== undefined && width !== limits.width) ||
    width * value.length > limits.maxCells
  )
    return;
  return value.every(
    (row) =>
      typeof row === 'string' &&
      row.length === width &&
      /^[0-9a-f]+$/.test(row) &&
      Array.from(row).every((index) => Number.parseInt(index, 16) < paletteLength)
  )
    ? (value as string[])
    : undefined;
}
