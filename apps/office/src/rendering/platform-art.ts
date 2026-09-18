import { CanvasSource, Texture } from 'pixi.js';
import sourceUrl from './assets/mechanical-platform-v1.png';

/** Source-pixel contours exclude the study sheet's opaque background. These are
 * authored sprite silhouettes, not color-key guesses or per-frame GPU masks. */
export const PLATFORM_FRAMES = {
  rim: { x: 115, y: 66, width: 65, height: 12 },
  face: { x: 172, y: 582, width: 102, height: 61 },
  lamp: {
    x: 439,
    y: 565,
    width: 153,
    height: 111,
    outline: [0, 0, 151, 0, 153, 69, 128, 96, 99, 96, 96, 110, 74, 110, 66, 97, 23, 96, 0, 75],
  },
  bracket: {
    x: 633,
    y: 557,
    width: 122,
    height: 135,
    outline: [
      18, 0, 105, 0, 122, 16, 115, 41, 108, 44, 108, 106, 82, 110, 80, 134, 51, 134, 43, 111, 20,
      106, 14, 40, 0, 27, 0, 14,
    ],
  },
  corner: {
    x: 797,
    y: 559,
    width: 143,
    height: 127,
    outline: [
      13, 0, 42, 8, 142, 8, 142, 98, 115, 99, 106, 122, 86, 122, 75, 99, 40, 91, 29, 55, 0, 27, 0,
      9,
    ],
  },
  deck: { x: 844, y: 780, width: 71, height: 128 },
  bridgeRail: { x: 823, y: 780, width: 20, height: 120 },
} as const;
export type PlatformTextures = Record<keyof typeof PLATFORM_FRAMES, Texture>;

/** One decoded source, fixed nearest-neighbor sprite textures for every room. */
export async function createPlatformArt(signal: AbortSignal) {
  if (signal.aborted) return;
  const image = new Image();
  image.src = sourceUrl;
  await image.decode();
  if (signal.aborted) return;
  if (image.naturalWidth !== 1536 || image.naturalHeight !== 1024)
    throw new Error('The mechanical platform sheet does not match its reviewed frames.');
  const textures = {} as PlatformTextures;
  function dispose() {
    for (const key of Object.keys(textures) as (keyof PlatformTextures)[]) {
      textures[key].destroy(true);
      delete textures[key];
    }
  }
  try {
    for (const key of Object.keys(PLATFORM_FRAMES) as (keyof PlatformTextures)[]) {
      const frame = PLATFORM_FRAMES[key];
      const canvas = document.createElement('canvas');
      canvas.width = frame.width;
      canvas.height = frame.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Mechanical platform artwork could not initialize.');
      if ('outline' in frame) {
        context.beginPath();
        const points = frame.outline;
        context.moveTo(points[0], points[1]);
        for (let i = 2; i < points.length; i += 2) context.lineTo(points[i]!, points[i + 1]!);
        context.closePath();
        context.clip();
      }
      context.drawImage(
        image,
        frame.x,
        frame.y,
        frame.width,
        frame.height,
        0,
        0,
        frame.width,
        frame.height
      );
      textures[key] = new Texture({
        source: new CanvasSource({ resource: canvas, scaleMode: 'nearest' }),
      });
    }
    return { textures, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
