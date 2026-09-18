import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { officeWorldFixture } from '../../../../test/support/office-world.js';
import { useWorldEditor } from './use-world-editor.js';

it('adopts a new saved observation but neither rebases a draft nor rolls back a confirmed save', async () => {
  const initial = officeWorldFixture();
  const newer = { ...initial, revision: 3, layout: { ...initial.layout, objects: [] } };
  const port = {
    show: vi.fn(async () => newer),
    save: vi.fn(async () => ({ ...newer, revision: 4 })),
  };
  const { result, rerender } = renderHook(({ snapshot }) => useWorldEditor(snapshot, port), {
    initialProps: { snapshot: initial },
  });
  act(() => result.current.begin());
  rerender({ snapshot: newer });
  expect(result.current.world).toEqual(initial.layout);
  expect(result.current.saved.revision).toBe(initial.revision);
  act(() => result.current.cancel());
  // An observation rejected during editing is not silently applied on Cancel.
  expect(result.current.world).toEqual(initial.layout);
  rerender({ snapshot: { ...newer } });
  expect(result.current.world).toEqual(newer.layout);
  act(() => result.current.begin());
  await act(() => result.current.save());
  expect(result.current.saved.revision).toBe(4);
  rerender({ snapshot: { ...initial } });
  expect(result.current.saved.revision).toBe(4);
  expect(result.current.world).toEqual(newer.layout);
});

it('does not reapply the original revision-zero observation after an explicit legacy reread', async () => {
  const initial = { ...officeWorldFixture(), revision: 0, legacyBasis: 'original' };
  const latest = { ...initial, legacyBasis: 'changed', layout: { ...initial.layout, objects: [] } };
  const port = { show: vi.fn(async () => latest), save: vi.fn() };
  const { result } = renderHook(() => useWorldEditor(initial, port));
  act(() => result.current.begin());
  await act(() => result.current.reload());
  expect(result.current.saved).toEqual(latest);
  expect(result.current.world).toEqual(latest.layout);
  expect(port.show).toHaveBeenCalledTimes(1);
  expect(port.save).not.toHaveBeenCalled();
});
