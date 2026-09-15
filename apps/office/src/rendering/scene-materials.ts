import { ImageSource, Texture } from 'pixi.js';
import floorUrl from '../blocks/assets/workshop-oak-v1.png';
import wallUrl from '../blocks/assets/workshop-wall-v1.png';

/** Fixed bundled architecture, decoded once per scene and shared by every room. */
export async function createSceneMaterials(signal: AbortSignal) {
  if (signal.aborted) return undefined;
  const images = [floorUrl, wallUrl].map((url) => {
    const image = new Image();
    image.src = url;
    return image;
  });
  await Promise.all(images.map((image) => image.decode()));
  if (signal.aborted) return undefined;
  const owned: Texture[] = [];
  function dispose() {
    for (const texture of owned.splice(0)) texture.destroy(true);
  }
  try {
    for (const image of images)
      owned.push(
        new Texture({ source: new ImageSource({ resource: image, scaleMode: 'nearest' }) })
      );
  } catch (error) {
    dispose();
    throw error;
  }
  return { floor: owned[0]!, wall: owned[1]!, dispose };
}
