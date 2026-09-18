import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { officeWorldFixture } from '../../../../test/support/office-world.js';
import { useWorldEditor } from './use-world-editor.js';
import { WorldConflict } from './world-port.js';
import type { WorldSnapshot, WorldWrite } from './world-port.js';

afterEach(() => vi.useRealTimers());
const advance = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(350);
  });

function fixture() {
  const initial = officeWorldFixture();
  let saved: WorldSnapshot = initial;
  const port = {
    show: vi.fn(async () => saved),
    save: vi.fn(async (write: WorldWrite) => {
      saved = { ...saved, revision: saved.revision + 1, layout: write.layout };
      return saved;
    }),
  };
  return { initial, port };
}

it('auto-applies changes once after a burst and keeps persisted undo/redo history', async () => {
  vi.useFakeTimers();
  const { initial, port } = fixture();
  const { result, unmount } = renderHook(() => useWorldEditor(initial, port));
  await advance();
  expect(port.save).not.toHaveBeenCalled();
  act(() => {
    result.current.change((world) => ({ ...world, objects: [] }));
    result.current.change((world) => ({
      ...world,
      objects: initial.layout.objects.map((object) => ({
        ...object,
        placement: { ...object.placement, x: 5 },
      })),
    }));
  });
  expect(port.save).not.toHaveBeenCalled();
  await advance();
  expect(port.save).toHaveBeenCalledTimes(1);
  expect(result.current.dirty).toBe(false);
  expect(result.current.canUndo).toBe(true);
  act(() => result.current.undo());
  await advance();
  expect(result.current.world.objects).toEqual([]);
  expect(port.save.mock.calls.at(-1)![0].expectedRevision).toBe(initial.revision + 1);
  act(() => result.current.redo());
  await advance();
  expect(result.current.world.objects[0]!.placement.x).toBe(5);
  expect(result.current.dirty).toBe(false);
  unmount();
});

it('serializes acknowledgements without losing edits made during a write', async () => {
  vi.useFakeTimers();
  const { initial, port } = fixture();
  let finish!: (value: WorldSnapshot) => void;
  port.save.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const { result, unmount } = renderHook(() => useWorldEditor(initial, port));
  act(() => result.current.change((world) => ({ ...world, objects: [] })));
  await advance();
  expect(result.current.saving).toBe(true);
  act(() => result.current.undo());
  await advance();
  expect(port.save).toHaveBeenCalledTimes(1);
  await act(async () =>
    finish({
      ...initial,
      revision: initial.revision + 1,
      layout: { ...initial.layout, objects: [] },
    })
  );
  expect(result.current.world).toEqual(initial.layout);
  await advance();
  expect(port.save).toHaveBeenCalledTimes(2);
  expect(port.save.mock.calls[1]![0]).toMatchObject({
    expectedRevision: initial.revision + 1,
    layout: initial.layout,
  });
  unmount();
});

it('retains failed changes without automatic retry or observation rebase; reload is explicit', async () => {
  vi.useFakeTimers();
  const { initial, port } = fixture();
  port.save.mockRejectedValueOnce(new WorldConflict());
  const { result, rerender, unmount } = renderHook(
    ({ snapshot }) => useWorldEditor(snapshot, port),
    {
      initialProps: { snapshot: initial },
    }
  );
  act(() => result.current.change((world) => ({ ...world, objects: [] })));
  await advance();
  expect(result.current.blocked).toBe(true);
  rerender({ snapshot: { ...initial, revision: 99 } });
  await advance();
  expect(result.current.world.objects).toEqual([]);
  expect(port.save).toHaveBeenCalledTimes(1);
  expect(port.show).not.toHaveBeenCalled();
  await act(() => result.current.reload());
  expect(result.current.world).toEqual(initial.layout);
  expect(result.current.blocked).toBe(false);
  expect(result.current.canUndo).toBe(false);
  unmount();
});

it('explicit retry retains the revision fence', async () => {
  vi.useFakeTimers();
  const { initial, port } = fixture();
  port.save.mockRejectedValueOnce(new Error('offline'));
  const { result, unmount } = renderHook(() => useWorldEditor(initial, port));
  act(() => result.current.change((world) => ({ ...world, objects: [] })));
  await advance();
  await act(() => result.current.retry());
  expect(result.current.dirty).toBe(false);
  expect(port.save.mock.calls[1]![0].expectedRevision).toBe(initial.revision);
  unmount();
});

it('does not write a cancelled debounce and accepts only newer clean observations', async () => {
  vi.useFakeTimers();
  const { initial, port } = fixture();
  const { result, rerender, unmount } = renderHook(
    ({ snapshot }) => useWorldEditor(snapshot, port),
    {
      initialProps: { snapshot: initial },
    }
  );
  act(() => {
    result.current.change((world) => ({ ...world, objects: [] }));
    result.current.undo();
  });
  await advance();
  expect(port.save).not.toHaveBeenCalled();
  const latest = {
    ...initial,
    revision: initial.revision + 2,
    layout: { ...initial.layout, objects: [] },
  };
  rerender({ snapshot: latest });
  expect(result.current.world).toEqual(latest.layout);
  rerender({ snapshot: { ...initial } });
  expect(result.current.saved).toEqual(latest);
  unmount();
});
