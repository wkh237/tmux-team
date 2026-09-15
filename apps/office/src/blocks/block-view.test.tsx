import { act, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import type { Block } from './block-contract.js';
import { BUILTIN_DIGEST } from '../props/prop-contract.js';
import { builtinFurniture } from './block-contract.js';
import { createBlockState } from './block-state.js';
import { BlockEditor } from './block-view.js';
import type { BlockSceneProps } from './block-scene.js';

it('keeps renderer interactions in the same revision-aware draft until explicit save', async () => {
  let scene!: BlockSceneProps;
  const apply = vi.fn(async (_id: string, _revision: number, objects: Block['objects']) => ({
    revision: 5,
    objects,
    updatedAtMs: 5,
  }));
  const state = createBlockState(
    {
      watch(_id, changed) {
        changed({ revision: 4, objects: [builtinFurniture('desk', 1, 1, 0)], updatedAtMs: 4 });
        return () => {};
      },
      apply,
    },
    'room'
  );
  const view = render(
    <BlockEditor
      state={state}
      renderScene={(props) => {
        scene = props;
        return null;
      }}
    />
  );
  try {
    const catalog = scene.catalog;
    const initialObjects = scene.objects;
    act(() => scene.select?.(0));
    expect(scene.catalog).toBe(catalog);
    expect(scene.objects).toBe(initialObjects);
    act(() => scene.move?.(8, 9));
    expect(scene.objects[0]).toMatchObject({ x: 8, y: 9 });
    expect(state.getSnapshot().remote?.objects[0]).toMatchObject({ x: 1, y: 1 });
    expect(apply).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Load latest layout' }));
    expect(scene.objects[0]).toMatchObject({ x: 1, y: 1 });
    expect(scene.selected).toBeNull();
    act(() => scene.select?.(0));
    act(() => scene.move?.(6, 7));
    await userEvent.click(screen.getByRole('button', { name: 'Save layout' }));
    expect(apply).toHaveBeenCalledExactlyOnceWith('room', 4, [builtinFurniture('desk', 6, 7, 0)]);
    expect(state.getSnapshot().draft).toBeNull();
  } finally {
    view.unmount();
    state.dispose();
  }
});

it('distinguishes connecting, absent, saved and unavailable block observations', () => {
  let changed: (block: Block | null) => void = () => {};
  let failed = () => {};
  const state = createBlockState(
    {
      watch: (_id, next, error) => {
        changed = next;
        failed = error;
        return () => {};
      },
      apply: async () => {
        throw new Error('This read-only scenario must not write.');
      },
    },
    'a'.repeat(20)
  );
  const view = render(<BlockEditor state={state} />);
  try {
    expect(screen.getByRole('status').textContent).toBe('Connecting…');
    act(() => changed(null));
    expect(screen.getByRole('status').textContent).toBe('No saved layout yet');
    act(() => changed({ revision: 1, objects: [], updatedAtMs: 1 }));
    expect(screen.getByRole('status').textContent).toBe('Saved · revision 1');
    act(failed);
    expect(screen.getByRole('status').textContent).toBe('Block unavailable');
    expect(screen.getByRole('alert').textContent).toContain('Reopen the world');
    expect(screen.queryByRole('button', { name: 'Save layout' })).toBeNull();
  } finally {
    view.unmount();
    state.dispose();
  }
});

it('keeps mismatched geometry as a bounded placeholder without dropping its neighbor', () => {
  let changed: (block: Block | null) => void = () => {};
  const state = createBlockState(
    {
      watch: (_id, next) => {
        changed = next;
        return () => {};
      },
      apply: async () => {
        throw new Error('This read-only scenario must not write.');
      },
    },
    'a'.repeat(20)
  );
  const objects = [
    { ...builtinFurniture('desk', 1, 1, 0), footprint: { width: 1, height: 1 } },
    builtinFurniture('chair', 4, 1, 0),
  ];
  const view = render(<BlockEditor state={state} />);
  try {
    act(() => changed({ revision: 7, objects, updatedAtMs: 7 }));
    expect(screen.getByRole('status').textContent).toBe('Saved · revision 7');
    expect(screen.getByRole('button', { name: 'Unavailable prop 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Chair 2' })).toBeTruthy();
    expect(
      screen.getByRole('img', { name: `Unavailable prop ${BUILTIN_DIGEST.slice(7, 19)}` })
    ).toBeTruthy();
    expect(view.container.querySelector('rect[fill="#dca77dff"]')).toBeTruthy();
    expect(state.getSnapshot().remote).toMatchObject({ revision: 7, objects });
  } finally {
    view.unmount();
    state.dispose();
  }
});
