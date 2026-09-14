import type { PropDefinition, PropPack } from './prop-contract.js';
import { IndexedRaster } from '../rendering/indexed-raster.js';

export function IndexedProp({ pack, prop }: { pack: PropPack; prop: PropDefinition }) {
  return (
    <IndexedRaster
      pixels={prop.pixels}
      palette={pack.palette}
      width={prop.footprint.width}
      height={prop.footprint.height}
    />
  );
}
