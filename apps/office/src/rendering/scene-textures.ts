import { CanvasSource, Texture } from 'pixi.js';
import type { AvatarArt } from '../profiles/avatar.js';

/** Admitted indexed art becomes one nearest-neighbor texture per scene/key. */
export function createSceneTextures() {
  const textures = new Map<string, Texture>();
  const used = new Set<string>();
  return {
    begin() {
      used.clear();
    },
    get(key: string, art: AvatarArt) {
      used.add(key);
      const existing = textures.get(key);
      if (existing) return existing;
      const canvas = document.createElement('canvas');
      canvas.width = art.pixels[0]!.length;
      canvas.height = art.pixels.length;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Pixel artwork could not initialize.');
      for (const [y, row] of art.pixels.entries()) {
        for (const [x, index] of Array.from(row).entries()) {
          if (index === '0') continue;
          context.fillStyle = art.palette[Number.parseInt(index, 16)]!;
          context.fillRect(x, y, 1, 1);
        }
      }
      const texture = new Texture({
        source: new CanvasSource({ resource: canvas, scaleMode: 'nearest' }),
      });
      textures.set(key, texture);
      return texture;
    },
    end() {
      for (const [key, texture] of textures) {
        if (!used.has(key)) {
          texture.destroy(true);
          textures.delete(key);
        }
      }
    },
    dispose() {
      for (const texture of textures.values()) texture.destroy(true);
      textures.clear();
      used.clear();
    },
  };
}
