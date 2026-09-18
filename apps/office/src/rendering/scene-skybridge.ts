import type { Container, Texture } from 'pixi.js';
import type { SceneRect } from './office-geometry.js';
import { createSceneFloor } from './scene-floor.js';

/** Bridge decking shares the platform plane. Boundaries own its edge trim. */
export function drawBridgeDeck(parent: Container, rect: SceneRect, texture: Texture) {
  parent.addChild(createSceneFloor(texture, rect));
}
