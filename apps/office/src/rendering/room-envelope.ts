import { Container, Graphics, Sprite } from 'pixi.js';
import type { Texture } from 'pixi.js';
import type { SceneRect } from './office-geometry.js';

/** Building fabric only; never adds furniture to the saved room layout. */
export function drawRoomEnvelope(
  parent: Container,
  room: SceneRect,
  floor: Texture,
  wall: Texture
) {
  const { x, y, width, height } = room;
  parent.addChild(
    new Graphics()
      .rect(x - 2, y - 2, width + 4, height + 4)
      .fill('#263d33')
      .rect(x - 1, y - 1, width + 2, height + 2)
      .fill('#b6bca0')
  );
  const surface = new Sprite(floor);
  surface.position.set(x, y);
  surface.width = width;
  surface.height = height;
  parent.addChild(surface);
  const finish = new Graphics()
    .rect(x, y, width, height)
    .fill({ color: '#eadcc0', alpha: 0.28 })
    .rect(x, y, width, 1)
    .fill({ color: '#152c26', alpha: 0.22 })
    .rect(x, y, 0.5, height)
    .fill({ color: '#152c26', alpha: 0.12 })
    .rect(x - 1.6, y - 1.9, width + 3.2, 0.6)
    .fill('#e8e5cb')
    .rect(x - 1.6, y - 1.3, 0.6, height + 2.3)
    .fill('#d4d6b8')
    .rect(x + width + 0.5, y - 1.3, 0.5, height + 2.3)
    .fill('#778a70');
  // Static daylight avoids a continuously evaluated lighting filter.
  finish
    .poly([x + 6, y, x + 18, y, x + 24, y + 17, x + 12, y + 17])
    .fill({ color: '#fff7d5', alpha: 0.16 });
  // The threshold is outside the editable 32x32 floor, not an occupied tile.
  finish
    .rect(x + width - 9, y + height, 6, 2)
    .fill('#b7a17c')
    .rect(x + width - 9, y + height + 1.5, 6, 0.25)
    .fill('#e4d0a5')
    .rect(x + width - 9.3, y + height, 0.3, 2)
    .fill('#eee6c9')
    .rect(x + width - 3, y + height, 0.3, 2)
    .fill('#eee6c9');
  parent.addChild(finish);
  // Elevation occupies architecture space above the editable floor. Every room
  // shares this texture; neither extra GPU uploads nor saved objects are needed.
  const elevation = new Sprite(wall);
  elevation.width = width + 3;
  elevation.height = elevation.width / 3;
  elevation.position.set(x - 1.5, y - elevation.height);
  parent.addChild(elevation);
}
