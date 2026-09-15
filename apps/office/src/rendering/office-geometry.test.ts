import { describe, expect, it } from 'vitest';
import { BLOCK_SIZE } from '../blocks/block-contract.js';
import {
  fitOfficeCamera,
  officeGeometry,
  scenePoint,
  zoomOfficeCamera,
} from './office-geometry.js';

describe('office scene geometry', () => {
  it('retains an empty building and commons without inventing rooms', () => {
    const scene = officeGeometry([]);
    expect(scene.rooms).toEqual([]);
    expect(scene.bounds.width).toBeGreaterThan(BLOCK_SIZE);
    expect(scene.commons.height).toBeGreaterThan(0);
    expect(scene.commons.y + scene.commons.height).toBe(scene.bounds.height);
  });

  it('uses stable identity order and the existing tile dimensions across rows', () => {
    const scene = officeGeometry(['alice', 'bob', 'casey', 'dev']);
    expect(scene.rooms.map((room) => room.identityId)).toEqual(['alice', 'bob', 'casey', 'dev']);
    for (const room of scene.rooms) {
      expect(room.width).toBe(BLOCK_SIZE);
      expect(room.height).toBe(BLOCK_SIZE);
      expect(room.x + room.width).toBeLessThan(scene.bounds.width);
      expect(room.y + room.height).toBeLessThan(scene.bounds.height);
      // The generated 3:1 back wall must fit above the floor, not overlap its
      // editable tiles or the preceding row's corridor.
      expect(room.y - (room.width + 3) / 3).toBeGreaterThanOrEqual(0);
    }
    expect(scene.rooms[3]!.x).toBe(scene.rooms[0]!.x);
    expect(scene.rooms[3]!.y).toBeGreaterThan(scene.rooms[0]!.y + BLOCK_SIZE);
    expect(scene.rooms[3]!.y - (BLOCK_SIZE + 3) / 3).toBeGreaterThan(
      scene.rooms[0]!.y + BLOCK_SIZE + 10
    );
  });

  it('packs a larger office into a balanced grid without inventing rooms', () => {
    const identities = Array.from({ length: 24 }, (_, index) => `agent-${index}`);
    const scene = officeGeometry(identities);
    expect(scene.rooms.map((room) => room.identityId)).toEqual(identities);
    expect(new Set(scene.rooms.map((room) => room.x)).size).toBe(6);
    expect(new Set(scene.rooms.map((room) => room.y)).size).toBe(4);
    expect(scene.bounds.width / scene.bounds.height).toBeGreaterThan(0.9);
    expect(scene.bounds.width / scene.bounds.height).toBeLessThan(1.1);
  });

  it.each([
    { x: 20, y: 90, width: 900, height: 700 },
    { x: 8, y: 80, width: 374, height: 400 },
  ])('fits inside the HUD-free viewport %#', (viewport) => {
    const { bounds } = officeGeometry(['alice', 'bob', 'casey']);
    const camera = fitOfficeCamera(bounds, viewport);
    // Allow division roundoff, not a visible pixel of overflow.
    const epsilon = 1e-8;
    expect(camera.x).toBeGreaterThanOrEqual(viewport.x - epsilon);
    expect(camera.y).toBeGreaterThanOrEqual(viewport.y - epsilon);
    expect(camera.x + bounds.width * camera.scale).toBeLessThanOrEqual(
      viewport.x + viewport.width + epsilon
    );
    expect(camera.y + bounds.height * camera.scale).toBeLessThanOrEqual(
      viewport.y + viewport.height + epsilon
    );
  });

  it('keeps pointer coordinates invariant when zooming a panned camera', () => {
    const camera = { x: -143, y: 59, scale: 6 };
    const point = scenePoint(camera, 217, 299);
    const zoomed = zoomOfficeCamera(camera, 12, 217, 299);
    expect(scenePoint(zoomed, 217, 299)).toEqual(point);
    expect(zoomed).toEqual({ x: -503, y: -181, scale: 12 });
  });
});
