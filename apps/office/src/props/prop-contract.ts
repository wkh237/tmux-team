import builtinDocument from '../../../../contracts/office/builtin-props-v1.tmtprop.json' with { type: 'json' };

export const BUILTIN_DIGEST =
  'sha256:5aa6a2d239d7111586abc06be799b2a1ec2ca46619752a90ae08a13e414afb6a';
export interface Footprint {
  width: number;
  height: number;
}
export interface PropDefinition {
  key: string;
  label: string;
  footprint: Footprint;
  pixels: string[];
}
export interface PropPack {
  formatVersion: 1;
  label: string;
  credit: string;
  license: string;
  palette: string[];
  props: PropDefinition[];
}
export interface CatalogPack {
  digest: string;
  pack: PropPack;
}

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid prop pack.');
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(object, key))
  )
    throw new Error('Invalid prop pack fields.');
  return object;
}
function text(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    new TextEncoder().encode(value).length >= 1 &&
    new TextEncoder().encode(value).length <= max &&
    !Array.from(value).some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    })
  );
}
function key(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value);
}

export function decodePropPack(value: unknown): PropPack {
  const object = record(value, ['formatVersion', 'label', 'credit', 'license', 'palette', 'props']);
  if (
    object.formatVersion !== 1 ||
    !text(object.label, 80) ||
    !text(object.credit, 120) ||
    typeof object.license !== 'string' ||
    !/^[A-Za-z0-9.+-]{1,64}$/.test(object.license) ||
    !Array.isArray(object.palette) ||
    object.palette.length < 1 ||
    object.palette.length > 16 ||
    object.palette[0] !== '#00000000' ||
    !object.palette
      .slice(1)
      .every((color) => typeof color === 'string' && /^#[0-9a-f]{6}ff$/.test(color)) ||
    !Array.isArray(object.props) ||
    object.props.length < 1 ||
    object.props.length > 16
  )
    throw new Error('Invalid prop pack values.');
  const keys = new Set<string>();
  let totalPixels = 0;
  const props = object.props.map((value) => {
    const prop = record(value, ['key', 'label', 'footprint', 'pixels']);
    const footprint = record(prop.footprint, ['width', 'height']);
    if (
      !key(prop.key) ||
      keys.has(prop.key) ||
      !text(prop.label, 80) ||
      !Number.isInteger(footprint.width) ||
      !Number.isInteger(footprint.height) ||
      (footprint.width as number) < 1 ||
      (footprint.width as number) > 8 ||
      (footprint.height as number) < 1 ||
      (footprint.height as number) > 8 ||
      !Array.isArray(prop.pixels) ||
      prop.pixels.length < 1 ||
      prop.pixels.length > 64
    )
      throw new Error('Invalid prop definition.');
    keys.add(prop.key);
    const width = typeof prop.pixels[0] === 'string' ? prop.pixels[0].length : 0;
    if (width < 1 || width > 64 || width * prop.pixels.length > 4096)
      throw new Error('Invalid prop raster.');
    const paletteLength = (object.palette as unknown[]).length;
    if (
      !prop.pixels.every(
        (row) =>
          typeof row === 'string' &&
          row.length === width &&
          /^[0-9a-f]+$/.test(row) &&
          Array.from(row).every((index) => Number.parseInt(index, 16) < paletteLength)
      )
    )
      throw new Error('Invalid prop pixels.');
    totalPixels += width * prop.pixels.length;
    return {
      key: prop.key,
      label: prop.label,
      footprint: { width: footprint.width as number, height: footprint.height as number },
      pixels: prop.pixels as string[],
    };
  });
  if (totalPixels > 65_536) throw new Error('Prop pack pixels exceed their bound.');
  return {
    formatVersion: 1,
    label: object.label,
    credit: object.credit,
    license: object.license,
    palette: object.palette as string[],
    props,
  };
}

export const BUILTIN_PACK = decodePropPack(builtinDocument);

export function indexedProp(pack: PropPack, key: string): PropDefinition | undefined {
  return pack.props.find((prop) => prop.key === key);
}
