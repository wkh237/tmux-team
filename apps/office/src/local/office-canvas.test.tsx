import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OfficeCanvas } from './office-canvas.js';

const scene = vi.hoisted(() => ({
  update: vi.fn(),
  selection: vi.fn(),
  editing: vi.fn(),
  fit: vi.fn(),
  dispose: vi.fn(),
}));
const create = vi.hoisted(() => vi.fn());
vi.mock('../rendering/office-scene.js', () => ({
  createOfficeScene: create,
}));
beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue(scene);
});
afterEach(() => vi.restoreAllMocks());

it('coalesces hidden input changes without rebuilding until visible, then detaches on unmount', async () => {
  let hidden = true;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  const select = vi.fn();
  const view = render(<OfficeCanvas model={{ rooms: [], catalog: [] }} select={select} />);
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  view.rerender(
    <OfficeCanvas model={{ rooms: [], catalog: [] }} select={select} selectedId="old" />
  );
  const newest = { rooms: [], catalog: [] };
  view.rerender(<OfficeCanvas model={newest} select={select} selectedId="new" />);
  expect(scene.update).not.toHaveBeenCalled();
  act(() => {
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(scene.update).toHaveBeenCalledExactlyOnceWith(newest);
  expect(scene.selection).toHaveBeenCalledExactlyOnceWith('new');
  view.unmount();
  document.dispatchEvent(new Event('visibilitychange'));
  expect(scene.update).toHaveBeenCalledTimes(1);
});

it('does not retain a failed initial scene for later prop updates', async () => {
  scene.update.mockImplementationOnce(() => {
    throw new Error('Raster initialization failed');
  });
  const select = vi.fn();
  const view = render(<OfficeCanvas model={{ rooms: [], catalog: [] }} select={select} />);
  await screen.findByRole('alert');
  expect(scene.update).toHaveBeenCalledTimes(1);
  view.rerender(
    <OfficeCanvas model={{ rooms: [], catalog: [] }} select={select} selectedId="changed" />
  );
  expect(scene.update).toHaveBeenCalledTimes(1);
  expect(scene.selection).not.toHaveBeenCalled();
  view.unmount();
});
