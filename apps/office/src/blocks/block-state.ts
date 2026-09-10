import { BlockConflict, validLayout } from './block-contract.js';
import type { Block, BlockPort, Furniture } from './block-contract.js';

interface Snapshot {
  ready: boolean;
  remote: Block | null;
  draft: { revision: number; objects: Furniture[] } | null;
  busy: boolean;
  error: string | null;
}
/** Created by the mounted block effect, never during React rendering. */
export function createBlockState(port: BlockPort, worldId: string) {
  let snapshot: Snapshot = { ready: false, remote: null, draft: null, busy: false, error: null };
  let disposed = false;
  const listeners = new Set<() => void>();
  function publish(next: Partial<Snapshot>) {
    if (disposed) return;
    snapshot = { ...snapshot, ...next };
    for (const listener of listeners) listener();
  }
  const stop = port.watch(
    worldId,
    (remote) => publish({ ready: true, remote }),
    () => {
      publish({
        ready: false,
        remote: null,
        draft: null,
        error: 'Block unavailable. Reopen the world to retry.',
      });
    }
  );
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    edit(objects: Furniture[]) {
      if (disposed || !snapshot.ready || snapshot.busy) return;
      if (!validLayout(objects)) {
        publish({ error: 'Keep furniture inside the room and use at most 16 items.' });
        return;
      }
      publish({
        draft: { revision: snapshot.draft?.revision ?? snapshot.remote?.revision ?? 0, objects },
        error: null,
      });
    },
    reset() {
      if (!snapshot.busy) publish({ draft: null, error: null });
    },
    async save() {
      if (disposed || !snapshot.ready || !snapshot.draft || snapshot.busy) return;
      const draft = snapshot.draft;
      publish({ busy: true, error: null });
      try {
        const remote = await port.apply(worldId, draft.revision, draft.objects);
        if (!snapshot.ready) return;
        publish({
          remote: (snapshot.remote?.revision ?? 0) > remote.revision ? snapshot.remote : remote,
          draft: null,
        });
      } catch (error) {
        publish({
          error:
            error instanceof BlockConflict
              ? error.message
              : 'Save could not be confirmed. Keep this draft and retry when connected.',
        });
      } finally {
        publish({ busy: false });
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      listeners.clear();
      snapshot = { ready: false, remote: null, draft: null, busy: false, error: null };
    },
  };
}
export type BlockState = ReturnType<typeof createBlockState>;
