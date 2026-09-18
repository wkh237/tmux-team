import { MODULE_METRICS } from './module-metrics.js';
import type { ModuleRect } from './module-geometry.js';

/** Required branches on the public lattice, not a filled map bounding box.
 * Each occupied office reaches the Lobby through a horizontal branch and the
 * central vertical spine. Private room floor is never used as a shortcut.
 * These candidate rectangles are clipped/merged by the map projection owner.
 */
export function compactCirculation(rooms: readonly ModuleRect[]): ModuleRect[] {
  const { roomWidth, roomHeight, passageWidth, lobbyWidth } = MODULE_METRICS;
  const centerX = roomWidth;
  const centerY = roomHeight;
  const lobbyHeight = 2 * roomHeight + passageWidth;
  const result: ModuleRect[] = [];
  for (const room of rooms) {
    if (room.x === 0 && room.y === 0 && room.width === lobbyWidth && room.height === lobbyHeight)
      continue;
    const branchY =
      room.y < 0 ? room.y + room.height : room.y >= lobbyHeight ? room.y - passageWidth : centerY;
    const entranceX = room.x + (room.width - passageWidth) / 2;
    result.push({
      x: Math.min(entranceX, centerX),
      y: branchY,
      width: Math.max(entranceX, centerX) + passageWidth - Math.min(entranceX, centerX),
      height: passageWidth,
    });
    result.push({
      x: centerX,
      y: Math.min(branchY, centerY),
      width: passageWidth,
      height: Math.max(branchY, centerY) + passageWidth - Math.min(branchY, centerY),
    });
  }
  return result;
}

/** Direct neighbors use only the short bridge at their entrance. More distant
 * rooms retain public access through the central spine, never a private room.
 */
export function skybridgeCirculation(rooms: readonly ModuleRect[]) {
  const { passageWidth: gap, lobbyWidth, roomHeight } = MODULE_METRICS;
  const lobbyHeight = 2 * roomHeight + gap;
  const direct: {
    room: ModuleRect;
    passage: ModuleRect;
    openings: { x: number; y: number; axis: 'horizontal' | 'vertical' }[];
  }[] = [];
  const remote: ModuleRect[] = [];
  for (const room of rooms) {
    const x = room.x + (room.width - gap) / 2;
    const y = room.y + (room.height - gap) / 2;
    const north = room.y + room.height === -gap;
    const south = room.y === lobbyHeight + gap;
    const west = room.x + room.width === -gap;
    const east = room.x === lobbyWidth + gap;
    if ((north || south) && room.x >= 0 && room.x + room.width <= lobbyWidth) {
      const edge = north ? -gap : lobbyHeight;
      direct.push({
        room,
        passage: { x, y: edge, width: gap, height: gap },
        openings: [
          { x, y: edge, axis: 'horizontal' },
          { x, y: edge + gap, axis: 'horizontal' },
        ],
      });
    } else if ((west || east) && room.y >= 0 && room.y + room.height <= lobbyHeight) {
      const edge = west ? -gap : lobbyWidth;
      direct.push({
        room,
        passage: { x: edge, y, width: gap, height: gap },
        openings: [
          { x: edge, y, axis: 'vertical' },
          { x: edge + gap, y, axis: 'vertical' },
        ],
      });
    } else remote.push(room);
  }
  const passages = direct.map(({ passage }) => passage);
  const openings = direct.flatMap(({ openings }) => openings);
  for (const room of remote) {
    if (room.x === 0 && room.y === 0 && room.width === lobbyWidth && room.height === lobbyHeight)
      continue;
    // Share a direct neighbor's public perimeter across empty slots. Prefer
    // the side-column shaft, then nearest distance and stable coordinate order.
    const neighbor = direct
      .filter(
        ({ room: other }) =>
          (other.x === room.x &&
            (other.x + other.width === -gap || other.x === lobbyWidth + gap)) ||
          (other.y === room.y && (other.y + other.height === -gap || other.y === lobbyHeight + gap))
      )
      .sort(
        (a, b) =>
          Number(a.room.x !== room.x) - Number(b.room.x !== room.x) ||
          Math.abs(a.room.x - room.x) +
            Math.abs(a.room.y - room.y) -
            Math.abs(b.room.x - room.x) -
            Math.abs(b.room.y - room.y) ||
          a.room.y - b.room.y ||
          a.room.x - b.room.x
      )[0];
    const x = room.x + (room.width - gap) / 2;
    if (neighbor) {
      const y = room.y + (room.height - gap) / 2;
      const target = neighbor.passage;
      const vertical = neighbor.room.x === room.x;
      passages.push(
        vertical
          ? {
              x: target.x,
              y: Math.min(y, target.y),
              width: gap,
              height: Math.max(y, target.y) + gap - Math.min(y, target.y),
            }
          : {
              x: Math.min(x, target.x),
              y: target.y,
              width: Math.max(x, target.x) + gap - Math.min(x, target.x),
              height: gap,
            }
      );
      openings.push(
        vertical
          ? { x: room.x < 0 ? room.x + room.width : room.x, y, axis: 'vertical' }
          : { x, y: room.y < 0 ? room.y + room.height : room.y, axis: 'horizontal' }
      );
      continue;
    }
    passages.push(...compactCirculation([room]));
    const north = room.y < 0;
    const south = room.y >= lobbyHeight;
    openings.push({
      x,
      y: north ? room.y + room.height : south || room.y > 0 ? room.y : room.y + room.height,
      axis: 'horizontal',
    });
    openings.push(
      north || south
        ? { x: MODULE_METRICS.roomWidth, y: north ? 0 : lobbyHeight, axis: 'horizontal' }
        : { x: room.x < 0 ? 0 : lobbyWidth, y: roomHeight, axis: 'vertical' }
    );
  }
  return { passages, openings };
}
