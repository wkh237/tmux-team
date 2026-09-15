import { afterEach, expect, it, vi } from 'vitest';
import { createSceneTextures } from './scene-textures.js';

const gpu = vi.hoisted(() => ({ allocations: vi.fn(), releases: vi.fn() }));
vi.mock('pixi.js', () => ({
  CanvasSource: class {
    constructor(options: unknown) {
      gpu.allocations(options);
    }
  },
  Texture: class {
    destroy = vi.fn((releaseSource: boolean) => gpu.releases(releaseSource));
  },
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const art = { pixels: ['01', '10'], palette: ['#00000000', '#abcdefff'] };

it('shares admitted artwork across objects and snapshots, releasing only unused textures', () => {
  const fillRect = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((kind: string) => {
    expect(kind).toBe('2d');
    return { fillRect };
  }) as unknown as HTMLCanvasElement['getContext']);
  const textures = createSceneTextures();
  textures.begin();
  const first = textures.get('pack/first', art);
  expect(textures.get('pack/first', art)).toBe(first);
  const second = textures.get('pack/second', art);
  textures.end();
  expect(gpu.allocations).toHaveBeenCalledTimes(2);
  expect(gpu.allocations).toHaveBeenCalledWith(expect.objectContaining({ scaleMode: 'nearest' }));
  expect(fillRect.mock.calls).toEqual([
    [1, 0, 1, 1],
    [0, 1, 1, 1],
    [1, 0, 1, 1],
    [0, 1, 1, 1],
  ]);
  textures.begin();
  expect(textures.get('pack/second', art)).toBe(second);
  textures.end();
  expect(first.destroy).toHaveBeenCalledWith(true);
  expect(second.destroy).not.toHaveBeenCalled();
  textures.dispose();
  textures.dispose();
  expect(first.destroy).toHaveBeenCalledTimes(1);
  expect(second.destroy).toHaveBeenCalledExactlyOnceWith(true);
});

it('does not cache a failed raster allocation', () => {
  const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const textures = createSceneTextures();
  textures.begin();
  expect(() => textures.get('retry', art)).toThrow('Pixel artwork could not initialize.');
  expect(gpu.allocations).not.toHaveBeenCalled();
  context.mockImplementation(((kind: string) => {
    expect(kind).toBe('2d');
    return { fillRect: vi.fn() };
  }) as unknown as HTMLCanvasElement['getContext']);
  textures.get('retry', art);
  expect(gpu.allocations).toHaveBeenCalledTimes(1);
  textures.dispose();
  expect(gpu.releases).toHaveBeenCalledExactlyOnceWith(true);
});
