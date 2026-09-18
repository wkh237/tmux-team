import { Container, Sprite, TilingSprite } from 'pixi.js';
import type { Texture } from 'pixi.js';
import type { PlatformTextures } from './platform-art.js';
import type { WallRun } from './world-geometry.js';
import type { SceneRect } from './office-geometry.js';

/** Fixed trim dimensions: a Lobby repeats the kit, never enlarges its hardware. */
export const PLATFORM_ART_SCALE = 0.045;

export function platformContour(rect: SceneRect): number[] {
  const { x, y, width: w, height: h } = rect;
  const c = Math.min(1.5, w / 4, h / 4);
  return [
    x + c,
    y,
    x + w - c,
    y,
    x + w,
    y + c,
    x + w,
    y + h - c,
    x + w - c,
    y + h,
    x + c,
    y + h,
    x,
    y + h - c,
    x,
    y + c,
  ];
}

export function drawPlatformEdge(
  parent: Container,
  wall: WallRun,
  bounds: SceneRect,
  art: PlatformTextures
) {
  const group = new Container();
  group.eventMode = 'none';
  group.position.set(bounds.x, bounds.y);
  parent.addChild(group);
  if (wall.open || bounds.width <= 0 || bounds.height <= 0) return group;
  const horizontal = wall.axis === 'horizontal';
  const length = horizontal ? bounds.width : bounds.height;
  function tile(texture: Texture, width: number, height: number, x = 0, y = 0) {
    const sprite = new TilingSprite({ texture, width, height });
    sprite.position.set(x, y);
    sprite.tileScale.set(PLATFORM_ART_SCALE);
    group.addChild(sprite);
    return sprite;
  }
  function detail(texture: Texture, x: number, y: number, mirrored = false) {
    const sprite = new Sprite(texture);
    sprite.scale.set(mirrored ? -PLATFORM_ART_SCALE : PLATFORM_ART_SCALE, PLATFORM_ART_SCALE);
    sprite.position.set(x, y);
    group.addChild(sprite);
  }
  if (wall.circulation) {
    // Bridge rails retain authored brass joints and lamp spacing in both axes.
    const rail = tile(art.bridgeRail, 0.9, length);
    if (horizontal) {
      rail.rotation = -Math.PI / 2;
      rail.y = 0.9;
    }
    return group;
  }
  if (!horizontal) {
    // Rotate a straight armor strip, not the tapered source side silhouette:
    // repeating a taper would create a saw-tooth edge along a large Lobby.
    const armor = tile(art.face, length, 1.8);
    armor.rotation = Math.PI / 2;
    armor.x = 1.8;
    const rim = tile(art.rim, length, 0.9);
    rim.tileScale.set(0.09);
    rim.rotation = Math.PI / 2;
    rim.x = wall.facing === 'positive' ? 1.8 : 0.9;
    return group;
  }
  tile(art.rim, length, 1.1).tileScale.set(0.09);
  if (wall.raised) return group;
  tile(art.face, length, 3.3, 0, 1.1);
  // Lamps and brackets are fixed-scale accents, centered within each repeat.
  for (let x = 4; x + 7 <= length; x += 16) {
    detail(art.lamp, x, 0);
    if (x + 14 <= length) detail(art.bracket, x + 8, -0.2);
  }
  if (wall.frontCorners?.start) detail(art.corner, 0, -0.25);
  if (wall.frontCorners?.end) detail(art.corner, length, -0.25, true);
  return group;
}
