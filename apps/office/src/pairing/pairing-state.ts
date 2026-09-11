import { PairingActionError } from './pairing-contract.js';
import type { ApprovedPairing, PairingRequest, PairingPort } from './pairing-contract.js';

interface PairingSnapshot {
  busy: boolean;
  attempted: boolean;
  approved: ApprovedPairing | null;
  revoked: boolean;
  error: string | null;
}

/** One mounted request owns actions; disposal fences results, not remote writes. */
export function createPairingState(port: PairingPort, request: PairingRequest, ownerUid: string) {
  let snapshot: PairingSnapshot = {
    busy: false,
    attempted: false,
    approved: null,
    revoked: false,
    error: null,
  };
  let disposed = false;
  const listeners = new Set<() => void>();
  function publish(change: Partial<PairingSnapshot>) {
    if (disposed) return;
    snapshot = { ...snapshot, ...change };
    for (const listener of listeners) listener();
  }
  async function act(action: () => Promise<Partial<PairingSnapshot>>) {
    if (disposed || snapshot.busy || snapshot.revoked) return;
    publish({ busy: true, attempted: true, error: null });
    try {
      publish(await action());
    } catch (error) {
      publish({
        error:
          error instanceof PairingActionError
            ? error.message
            : new PairingActionError('uncertain').message,
      });
    } finally {
      publish({ busy: false });
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    approve: () => act(async () => ({ approved: await port.approve(request, ownerUid) })),
    revoke: () =>
      act(async () => {
        await port.revoke(request.pairingId, ownerUid);
        return { approved: null, revoked: true };
      }),
    dispose() {
      disposed = true;
      listeners.clear();
      snapshot = { busy: false, attempted: false, approved: null, revoked: false, error: null };
    },
  };
}

export type PairingState = ReturnType<typeof createPairingState>;
