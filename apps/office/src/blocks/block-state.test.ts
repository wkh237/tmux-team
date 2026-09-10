import { describe, expect, it, vi } from 'vitest';
import { createBlockState } from './block-state.js';
import { BlockConflict } from './block-contract.js';
import type { Block, BlockPort, Furniture } from './block-contract.js';
const objects: Furniture[] = [{ asset: 'desk', x: 0, y: 0, rotation: 0 }];
function fixture() {
  let changed: (block: Block | null) => void = () => {};
  let failed = () => {};
  const stop = vi.fn();
  const port: BlockPort = {
    watch: (_id, next, error) => {
      changed = next;
      failed = error;
      return stop;
    },
    apply: vi.fn(async (_id, revision, next) => ({
      revision: revision + 1,
      objects: next,
      updatedAtMs: 1,
    })),
  };
  const state = createBlockState(port, 'a'.repeat(20));
  return {
    state,
    port,
    stop,
    changed: (block: Block | null) => changed(block),
    failed: () => failed(),
  };
}
describe('one block editor lifetime', () => {
  it('keeps edits local until explicit save commits the captured revision', async () => {
    const f = fixture();
    f.changed(null);
    f.state.edit(objects);
    expect(f.port.apply).not.toHaveBeenCalled();
    await f.state.save();
    expect(f.port.apply).toHaveBeenCalledExactlyOnceWith('a'.repeat(20), 0, objects);
    expect(f.state.getSnapshot()).toMatchObject({
      draft: null,
      remote: { revision: 1, objects },
      busy: false,
    });
    f.state.dispose();
  });
  it('retains the original draft across remote edits and conflicts', async () => {
    const f = fixture();
    f.changed(null);
    f.state.edit(objects);
    f.changed({ revision: 1, objects: [], updatedAtMs: 1 });
    vi.mocked(f.port.apply).mockRejectedValueOnce(new BlockConflict());
    await f.state.save();
    expect(f.state.getSnapshot().draft).toEqual({ revision: 0, objects });
    expect(f.state.getSnapshot().error).toContain('changed');
    f.state.reset();
    expect(f.state.getSnapshot()).toMatchObject({
      draft: null,
      remote: { revision: 1, objects: [] },
    });
    f.state.dispose();
  });
  it('transport failure preserves a retry and blocks concurrent saves', async () => {
    const f = fixture();
    f.changed(null);
    f.state.edit(objects);
    vi.mocked(f.port.apply).mockRejectedValueOnce(new Error('network'));
    const first = f.state.save();
    await f.state.save();
    await first;
    expect(f.port.apply).toHaveBeenCalledTimes(1);
    expect(f.state.getSnapshot().error).toContain('could not be confirmed');
    await f.state.save();
    expect(f.port.apply).toHaveBeenNthCalledWith(2, 'a'.repeat(20), 0, objects);
    f.state.dispose();
  });
  it('disposal clears content and fences late callbacks and saves', async () => {
    const f = fixture();
    f.changed(null);
    f.state.edit(objects);
    let resolve: (block: Block) => void = () => {};
    vi.mocked(f.port.apply).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const pending = f.state.save();
    f.state.dispose();
    f.state.dispose();
    const block = { revision: 1, objects, updatedAtMs: 1 };
    f.changed(block);
    resolve(block);
    await pending;
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.state.getSnapshot()).toMatchObject({ ready: false, remote: null, draft: null });
  });
  it('permission failure clears content and blocks edits', async () => {
    const f = fixture();
    f.changed({ revision: 1, objects, updatedAtMs: 1 });
    f.state.edit([]);
    f.failed();
    f.state.edit(objects);
    await f.state.save();
    expect(f.state.getSnapshot()).toMatchObject({ ready: false, remote: null, draft: null });
    expect(f.port.apply).not.toHaveBeenCalled();
    f.state.dispose();
  });
});
