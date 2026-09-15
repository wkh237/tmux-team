import { BLOCK_SIZE } from '../blocks/block-contract.js';

export interface SceneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface OfficeCamera {
  x: number;
  y: number;
  scale: number;
}

const WALL = 2;
const BACK_WALL = 12;
const CORRIDOR = 10;
const ROOM_PITCH = BLOCK_SIZE + WALL * 2;
const ROW_PITCH = BACK_WALL + BLOCK_SIZE + WALL + CORRIDOR;

/** Scene coordinates are existing room tiles, never another saved layout. */
export function officeGeometry(identityIds: readonly string[]) {
  const columns = Math.min(3, Math.max(1, identityIds.length));
  const rows = Math.max(1, Math.ceil(identityIds.length / columns));
  const rooms = identityIds.map((identityId, index) => ({
    identityId,
    x: (index % columns) * ROOM_PITCH + WALL,
    y: Math.floor(index / columns) * ROW_PITCH + BACK_WALL,
    width: BLOCK_SIZE,
    height: BLOCK_SIZE,
  }));
  return {
    rooms,
    bounds: {
      x: 0,
      y: 0,
      width: columns * ROOM_PITCH,
      height: rows * ROW_PITCH,
    },
    commons: {
      x: WALL,
      y: rows * ROW_PITCH - CORRIDOR,
      width: columns * ROOM_PITCH - WALL * 2,
      height: CORRIDOR,
    },
  };
}

/** The caller supplies the viewport area not occupied by HUD controls. */
export function fitOfficeCamera(bounds: SceneRect, viewport: SceneRect): OfficeCamera {
  if (viewport.width <= 0 || viewport.height <= 0) return { x: 0, y: 0, scale: 1 };
  const scale = Math.min(viewport.width / bounds.width, viewport.height / bounds.height);
  return {
    scale,
    x: viewport.x + (viewport.width - bounds.width * scale) / 2 - bounds.x * scale,
    y: viewport.y + (viewport.height - bounds.height * scale) / 2 - bounds.y * scale,
  };
}

export function scenePoint(camera: OfficeCamera, x: number, y: number) {
  return { x: (x - camera.x) / camera.scale, y: (y - camera.y) / camera.scale };
}

/** Keep the tile under the pointer stationary while zooming. */
export function zoomOfficeCamera(camera: OfficeCamera, scale: number, x: number, y: number) {
  const point = scenePoint(camera, x, y);
  return { scale, x: x - point.x * scale, y: y - point.y * scale };
}
