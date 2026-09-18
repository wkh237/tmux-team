import { afterEach, expect, it, vi } from 'vitest';
import { createPlatformArt, PLATFORM_FRAMES } from './platform-art.js';

const evidence = vi.hoisted(() => ({ disposed: 0, decoded: 0 }));
vi.mock('pixi.js', () => ({
  CanvasSource: class {},
  Texture: class {
    destroy() {
      evidence.disposed++;
    }
  },
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  evidence.disposed = evidence.decoded = 0;
});

function images(width = 1536) {
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = width;
      naturalHeight = 1024;
      async decode() {
        evidence.decoded++;
      }
    }
  );
}

it('decodes once, clips silhouettes once, and disposes textures once', async () => {
  images();
  const context = {
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    closePath: vi.fn(),
    clip: vi.fn(),
    drawImage: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as ReturnType<HTMLCanvasElement['getContext']>
  );
  const art = (await createPlatformArt(new AbortController().signal))!;
  const count = Object.keys(PLATFORM_FRAMES).length;
  expect(evidence.decoded).toBe(1);
  expect(context.drawImage).toHaveBeenCalledTimes(count);
  expect(context.clip).toHaveBeenCalledTimes(3);
  expect(Object.keys(art.textures)).toHaveLength(count);
  art.dispose();
  art.dispose();
  expect(evidence.disposed).toBe(count);
});

it('rejects unreviewed source dimensions before creating textures', async () => {
  images(1024);
  await expect(createPlatformArt(new AbortController().signal)).rejects.toThrow('reviewed frames');
  expect(evidence.disposed).toBe(0);
});

it('allocates nothing for an aborted mount', async () => {
  images();
  const controller = new AbortController();
  controller.abort();
  expect(await createPlatformArt(controller.signal)).toBeUndefined();
  expect(evidence.decoded).toBe(0);
});
