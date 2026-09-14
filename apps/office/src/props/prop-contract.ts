import builtinDocument from '../../../../contracts/office/builtin-props-v1.tmtprop.json' with { type: 'json' };
import {
  boundedText,
  exactRecord,
  indexedArtKey,
  INDEXED_ART_LIMITS,
  indexedLicense,
  indexedPalette,
  indexedRaster,
} from '../rendering/indexed-art-contract.js';

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

export function decodePropPack(value: unknown): PropPack {
  const object = exactRecord(
    value,
    ['formatVersion', 'label', 'credit', 'license', 'palette', 'props'],
    'prop pack'
  );
  const palette = object.palette;
  if (
    object.formatVersion !== 1 ||
    !boundedText(object.label, INDEXED_ART_LIMITS.labelBytes) ||
    !boundedText(object.credit, INDEXED_ART_LIMITS.creditBytes) ||
    !indexedLicense(object.license) ||
    !indexedPalette(palette) ||
    !Array.isArray(object.props) ||
    object.props.length < 1 ||
    object.props.length > 16
  )
    throw new Error('Invalid prop pack values.');
  const keys = new Set<string>();
  let totalPixels = 0;
  const props = object.props.map((value) => {
    const prop = exactRecord(value, ['key', 'label', 'footprint', 'pixels'], 'prop definition');
    const footprint = exactRecord(prop.footprint, ['width', 'height'], 'prop footprint');
    if (
      !indexedArtKey(prop.key) ||
      keys.has(prop.key) ||
      !boundedText(prop.label, INDEXED_ART_LIMITS.labelBytes) ||
      !Number.isInteger(footprint.width) ||
      !Number.isInteger(footprint.height) ||
      (footprint.width as number) < 1 ||
      (footprint.width as number) > 8 ||
      (footprint.height as number) < 1 ||
      (footprint.height as number) > 8 ||
      !Array.isArray(prop.pixels)
    )
      throw new Error('Invalid prop definition.');
    keys.add(prop.key);
    const pixels = indexedRaster(prop.pixels, palette.length, {
      maxSide: 64,
      maxCells: 4096,
    });
    if (!pixels) throw new Error('Invalid prop pixels.');
    totalPixels += pixels[0]!.length * pixels.length;
    return {
      key: prop.key,
      label: prop.label,
      footprint: { width: footprint.width as number, height: footprint.height as number },
      pixels,
    };
  });
  if (totalPixels > 65_536) throw new Error('Prop pack pixels exceed their bound.');
  return {
    formatVersion: 1,
    label: object.label,
    credit: object.credit,
    license: object.license,
    palette,
    props,
  };
}

export const BUILTIN_PACK = decodePropPack(builtinDocument);

export function indexedProp(pack: PropPack, key: string): PropDefinition | undefined {
  return pack.props.find((prop) => prop.key === key);
}

export function resolvedProp(
  pack: PropPack,
  key: string,
  footprint: Footprint
): PropDefinition | undefined {
  const prop = indexedProp(pack, key);
  return prop &&
    prop.footprint.width === footprint.width &&
    prop.footprint.height === footprint.height
    ? prop
    : undefined;
}
