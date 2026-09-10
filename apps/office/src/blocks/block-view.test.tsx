import { act, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { Block } from './block-contract.js';
import { createBlockState } from './block-state.js';
import { BlockEditor } from './block-view.js';

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
