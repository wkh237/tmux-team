import { footprint } from '../blocks/block-contract.js';
import type { PropDefinition } from '../props/prop-contract.js';
import type { WorldObject } from './world-contract.js';

/** Repeated directional frames are static artwork, not four authored views. */
export function hasRotationArt(prop: PropDefinition): boolean {
  return !prop.frames || new Set(prop.frames.map((frame) => JSON.stringify(frame))).size > 1;
}

/** Keep the ground footprint centered, snapping its origin to the world grid. */
export function rotatedObject(object: WorldObject, turns: number): WorldObject {
  const before = footprint(object.placement);
  const rotation = (((object.placement.rotation + turns) % 4) + 4) % 4;
  const placement = { ...object.placement, rotation };
  const after = footprint(placement);
  return {
    ...object,
    placement: {
      ...placement,
      x: Math.round(placement.x + (before.width - after.width) / 2),
      y: Math.round(placement.y + (before.height - after.height) / 2),
    },
  };
}
