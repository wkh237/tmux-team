import { expect, it } from 'vitest';
import { platformProjection, PLATFORM_BRIDGE_LENGTH } from './platform-projection.js';
import { skybridgeCirculation } from '../world-map/compact-circulation.js';

it('keeps extended-row links narrow instead of stretching a perimeter floor band', () => {
  const rooms = [
    { x: 0, y: 0, width: 104, height: 88 },
    ...[0, 1, 2, 3].map((column) => ({ x: column * 56, y: -48, width: 48, height: 40 })),
  ];
  const projection = platformProjection(rooms, 7 / 8);
  const links = skybridgeCirculation(rooms).passages;
  expect(links).toHaveLength(5);
  for (const link of links) {
    const rect = projection.projectGroundRect(link);
    expect(rect.width <= 8 || rect.height <= 7).toBe(true);
    expect(link.width).toBe(8);
    expect(link.height).toBe(8);
  }
  expect(links.some((link) => link.x >= 104 && link.y === -8)).toBe(false);
});

it('uses one standard bridge span while retaining room dimensions and the Lobby origin', () => {
  const rooms = [
    { x: 0, y: -48, width: 48, height: 40 },
    { x: 0, y: 0, width: 104, height: 88 },
    { x: 0, y: 96, width: 48, height: 40 },
  ];
  const projection = platformProjection(rooms, 7 / 8);
  expect(PLATFORM_BRIDGE_LENGTH).toBe(24);
  expect(projection.projectGround({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  for (const room of rooms) {
    const rendered = projection.projectModuleFloor(room);
    expect(rendered.width).toBe(room.width);
    expect(rendered.height).toBe((room.height * 7) / 8);
  }
  for (const y of [-8, 88]) {
    const bridge = projection.projectGroundRect({ x: 20, y, width: 8, height: 8 });
    expect(bridge.height).toBe((24 * 7) / 8);
    expect(bridge.width).toBe(8);
  }
  for (const y of [-100, -48, -8, -4.5, 0, 44, 88, 92.5, 96, 200]) {
    const point = { x: 20, y };
    expect(projection.unprojectGround(projection.projectGround(point))).toEqual(point);
  }
});

it('uses the same connector length horizontally and does not stretch sprite artwork', () => {
  const projection = platformProjection(
    [
      { x: -56, y: 0, width: 48, height: 40 },
      { x: 0, y: 0, width: 104, height: 88 },
    ],
    7 / 8
  );
  expect(projection.projectGroundRect({ x: -8, y: 16, width: 8, height: 8 }).width).toBe(24);
  const art = projection.projectUpright({ x: -48, y: 8, width: 12, height: 16 });
  expect(art.width).toBe(12);
  expect(art.height).toBe(16);
  for (const x of [-64, -8, -3.5, 0, 120]) {
    const point = { x, y: 22 };
    expect(projection.unprojectGround(projection.projectGround(point))).toEqual(point);
  }
});
