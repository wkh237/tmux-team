import { Container, NineSliceSprite, Sprite } from 'pixi.js';
import type { Texture } from 'pixi.js';
import { ARCHITECTURE_BORDERS, ARCHITECTURE_FRAMES } from './architecture-art.js';
import { wallProjection } from './world-geometry.js';
import type { WallRun } from './world-geometry.js';
import { flatProjection } from './world-projection.js';

type WallArt = keyof typeof ARCHITECTURE_BORDERS;
export type WallTextures = Record<WallArt, Texture>;
const SOURCE_PIXEL_SCALE = 0.08;

/** The same derived wall owns its cutaway bounds, source art and paint depth. */
export function drawWall(
  parent: Container,
  wall: WallRun,
  textures: WallTextures,
  projection = flatProjection,
  editing = false
) {
  const { art, bounds, depth } = wallProjection(wall, projection);
  const side = (art === 'left' || art === 'right') && !wall.circulation;
  const paintedArt = side ? (art === 'left' ? 'leftBody' : 'rightBody') : art;
  const crownHeight = side && wall.sideStart !== false ? Math.min(5, bounds.height) : 0;
  const [leftWidth, rightWidth, topHeight, bottomHeight] = ARCHITECTURE_BORDERS[paintedArt];
  // A narrow opening must retain its transparent center. Nine-slice's default
  // border compression consumes that center when the two jambs exceed its width.
  const scaleX = Math.min(SOURCE_PIXEL_SCALE, bounds.width / ARCHITECTURE_FRAMES[paintedArt].width);
  // Solid walls retain their crown/base sizes as the infill gets shorter.
  // Portals instead retain a proportional opening, including narrow jambs.
  const sourceHeight =
    art === 'back' || art === 'sill'
      ? topHeight + bottomHeight + 1
      : ARCHITECTURE_FRAMES[paintedArt].height;
  const scaleY = Math.min(SOURCE_PIXEL_SCALE, (bounds.height - crownHeight) / sourceHeight);
  const sprite = new NineSliceSprite({
    texture: textures[paintedArt],
    leftWidth,
    rightWidth,
    topHeight,
    bottomHeight,
    width: bounds.width / scaleX,
    height: (bounds.height - crownHeight) / scaleY,
  });
  sprite.scale.set(scaleX, scaleY);
  sprite.position.set(bounds.x, bounds.y + crownHeight);
  sprite.alpha = editing ? 0.25 : 1;
  parent.addChild(sprite);
  if (crownHeight) {
    const crown = new Sprite({ texture: textures[art === 'left' ? 'leftCrown' : 'rightCrown'] });
    crown.position.set(bounds.x, bounds.y);
    crown.width = bounds.width;
    crown.height = crownHeight;
    crown.alpha = sprite.alpha;
    parent.addChild(crown);
  }
  if (art === 'sill' && !wall.circulation && wall.frontCorners) {
    const width = Math.min(6, bounds.width / 2);
    for (const [present, x] of [
      [wall.frontCorners.start, bounds.x],
      [wall.frontCorners.end, bounds.x + bounds.width - width],
    ] as const) {
      if (!present) continue;
      const post = new Sprite({ texture: textures.frontPost });
      post.position.set(x, bounds.y);
      post.width = width;
      post.height = bounds.height;
      post.alpha = editing ? 0.5 : 1;
      parent.addChild(post);
    }
  }
  return { sprite, depth };
}
