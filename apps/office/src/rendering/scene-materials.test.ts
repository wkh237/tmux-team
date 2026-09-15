import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSceneMaterials } from './scene-materials.js';

const calls = vi.hoisted(() => ({
  decode: vi.fn<() => Promise<void>>(),
  textures: [] as { destroy: ReturnType<typeof vi.fn> }[],
}));
vi.mock('pixi.js', () => ({
  ImageSource: class {},
  Texture: class {
    destroy = vi.fn();
    constructor() {
      calls.textures.push(this);
    }
  },
}));

beforeEach(() => {
  calls.decode.mockResolvedValue(undefined);
  vi.stubGlobal(
    'Image',
    class {
      src = '';
      decode() {
        return calls.decode();
      }
    }
  );
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  calls.textures.length = 0;
});

it('decodes the fixed material set once and releases both textures exactly once', async () => {
  const materials = await createSceneMaterials(new AbortController().signal);
  expect(calls.decode).toHaveBeenCalledTimes(2);
  expect(materials?.floor).toBe(calls.textures[0]);
  expect(materials?.wall).toBe(calls.textures[1]);
  expect(materials?.floor).not.toBe(materials?.wall);
  materials?.dispose();
  materials?.dispose();
  expect(calls.textures).toHaveLength(2);
  for (const texture of calls.textures) {
    expect(texture.destroy).toHaveBeenCalledExactlyOnceWith(true);
  }
});

it('does not allocate textures when decoding finishes after cancellation', async () => {
  let finish!: () => void;
  calls.decode.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  // Let one image decode; keep the second pending through cancellation.
  calls.decode.mockResolvedValueOnce(undefined);
  const controller = new AbortController();
  const pending = createSceneMaterials(controller.signal);
  controller.abort();
  finish();
  expect(await pending).toBeUndefined();
  expect(calls.textures).toHaveLength(0);
});

it('rejects decode failure before creating any GPU textures', async () => {
  calls.decode.mockRejectedValueOnce(new Error('Invalid bundled image'));
  await expect(createSceneMaterials(new AbortController().signal)).rejects.toThrow(
    'Invalid bundled image'
  );
  expect(calls.textures).toHaveLength(0);
});

it('does not start image work for a cancelled scene', async () => {
  const controller = new AbortController();
  controller.abort();
  expect(await createSceneMaterials(controller.signal)).toBeUndefined();
  expect(calls.decode).not.toHaveBeenCalled();
});
