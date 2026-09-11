import { expect, it, vi } from 'vitest';
import { createPairingState } from './pairing-state.js';
import { PairingActionError } from './pairing-contract.js';
import type { ApprovedPairing, PairingRequest, PairingPort } from './pairing-contract.js';

const request: PairingRequest = {
  version: 1,
  pairingId: 'a'.repeat(64),
  worldId: 'a'.repeat(20),
  installationId: '00000000-0000-4000-8000-000000000001',
  identityId: '00000000-0000-4000-8000-000000000002',
  installationLabel: 'Workstation',
  identityLabel: 'Alice',
  capabilities: ['layout.read'],
};
const binding: ApprovedPairing = {
  ...request,
  principalUid: 'office-agent:00000000-0000-4000-8000-000000000003',
  blockId: '00000000-0000-4000-8000-000000000004',
  expiresAt: 2_000_000_000_000,
};
function fixture() {
  const port: PairingPort = { approve: vi.fn(async () => binding), revoke: vi.fn(async () => {}) };
  return { port, state: createPairingState(port, request, 'owner') };
}

it('viewing is read-only; concurrent actions serialize and uncertain approval retries preserve the request', async () => {
  const { port, state } = fixture();
  expect(port.approve).not.toHaveBeenCalled();
  let reject: (error: Error) => void = () => {};
  vi.mocked(port.approve).mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      })
  );
  const pending = state.approve();
  await state.approve();
  await state.revoke();
  expect(port.approve).toHaveBeenCalledExactlyOnceWith(request, 'owner');
  expect(port.revoke).not.toHaveBeenCalled();
  reject(new Error('Do not expose a bearer or raw service failure'));
  await pending;
  expect(state.getSnapshot()).toMatchObject({ attempted: true, busy: false, approved: null });
  expect(state.getSnapshot().error).toContain('may already have completed');
  expect(state.getSnapshot().error).not.toContain('bearer');
  await state.approve();
  expect(port.approve).toHaveBeenLastCalledWith(request, 'owner');
  expect(state.getSnapshot().approved).toEqual(binding);
  state.dispose();
});

it('failed revocation preserves confirmed approval; explicit retry revokes once without reapproval', async () => {
  const { port, state } = fixture();
  await state.approve();
  vi.mocked(port.revoke).mockRejectedValueOnce(new PairingActionError('uncertain'));
  await state.revoke();
  expect(state.getSnapshot()).toMatchObject({ approved: binding, revoked: false });
  await state.revoke();
  expect(port.revoke).toHaveBeenLastCalledWith(request.pairingId, 'owner');
  expect(state.getSnapshot()).toMatchObject({ approved: null, revoked: true, error: null });
  await state.approve();
  expect(port.approve).toHaveBeenCalledOnce();
  state.dispose();
});

it('disposal clears private results, suppresses late completion and prevents subsequent actions', async () => {
  const { port, state } = fixture();
  let resolve: (binding: ApprovedPairing) => void = () => {};
  vi.mocked(port.approve).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const changed = vi.fn();
  state.subscribe(changed);
  const pending = state.approve();
  expect(changed).toHaveBeenCalledOnce();
  state.dispose();
  resolve(binding);
  await pending;
  await state.approve();
  expect(changed).toHaveBeenCalledOnce();
  expect(state.getSnapshot()).toMatchObject({ approved: null, attempted: false, busy: false });
  expect(port.approve).toHaveBeenCalledOnce();
});
