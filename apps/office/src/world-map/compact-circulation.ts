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
