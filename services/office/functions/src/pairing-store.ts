import { randomUUID } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import {
  APPROVAL_MS,
  CLAIM_INTERVAL_MS,
  GRANT_MS,
  UUID,
  PairingError,
  exact,
  object,
  parseApproval,
} from './pairing-contract.js';
import type { Approval } from './pairing-contract.js';

interface Pairing {
  request: Approval;
  ownerUid: string;
  principalUid: string;
  blockId: string;
  createdAt: Timestamp;
  expiresAt: Timestamp;
  enabled: boolean;
  claimed: boolean;
  nextClaimAt: Timestamp;
}

export interface ApprovedBinding extends Approval {
  principalUid: string;
  blockId: string;
  expiresAt: number;
}

function unavailable(): never {
  throw new PairingError('PAIRING_UNAVAILABLE');
}

function decode(input: unknown, id: string): Pairing {
  try {
    const value = object(input);
    exact(value, [
      'request',
      'ownerUid',
      'principalUid',
      'blockId',
      'createdAt',
      'expiresAt',
      'enabled',
      'claimed',
      'nextClaimAt',
    ]);
    const request = parseApproval(value.request);
    if (
      request.pairingId !== id ||
      typeof value.ownerUid !== 'string' ||
      !value.ownerUid ||
      typeof value.principalUid !== 'string' ||
      !value.principalUid.startsWith('office-agent:') ||
      !UUID.test(value.principalUid.slice('office-agent:'.length)) ||
      typeof value.blockId !== 'string' ||
      !UUID.test(value.blockId) ||
      !(value.createdAt instanceof Timestamp) ||
      !(value.expiresAt instanceof Timestamp) ||
      !(value.nextClaimAt instanceof Timestamp) ||
      typeof value.enabled !== 'boolean' ||
      typeof value.claimed !== 'boolean'
    )
      return unavailable();
    return {
      request,
      ownerUid: value.ownerUid,
      principalUid: value.principalUid,
      blockId: value.blockId,
      createdAt: value.createdAt,
      expiresAt: value.expiresAt,
      enabled: value.enabled,
      claimed: value.claimed,
      nextClaimAt: value.nextClaimAt,
    };
  } catch {
    return unavailable();
  }
}

function active(pairing: Pairing, now: number): void {
  if (
    !pairing.enabled ||
    pairing.createdAt.toMillis() > now ||
    pairing.expiresAt.toMillis() <= now ||
    pairing.expiresAt.toMillis() - pairing.createdAt.toMillis() !== APPROVAL_MS
  )
    unavailable();
}

function view(pairing: Pairing): ApprovedBinding {
  return {
    ...pairing.request,
    principalUid: pairing.principalUid,
    blockId: pairing.blockId,
    expiresAt: pairing.expiresAt.toMillis(),
  };
}

function sameRequest(left: Approval, right: Approval): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validGrant(input: unknown, pairing: Pairing, now: number): void {
  try {
    const value = object(input);
    exact(value, [
      'version',
      'ownerUid',
      'installationId',
      'identityId',
      'blockId',
      'capabilities',
      'enabled',
      'createdAt',
      'expiresAt',
    ]);
    if (
      value.version !== 1 ||
      value.ownerUid !== pairing.ownerUid ||
      value.installationId !== pairing.request.installationId ||
      value.identityId !== pairing.request.identityId ||
      value.blockId !== pairing.blockId ||
      JSON.stringify(value.capabilities) !== JSON.stringify(pairing.request.capabilities) ||
      value.enabled !== true ||
      !(value.createdAt instanceof Timestamp) ||
      !(value.expiresAt instanceof Timestamp) ||
      value.createdAt.toMillis() > now ||
      value.expiresAt.toMillis() <= now ||
      value.expiresAt.toMillis() <= value.createdAt.toMillis() ||
      value.expiresAt.toMillis() - value.createdAt.toMillis() > GRANT_MS
    )
      unavailable();
  } catch {
    unavailable();
  }
}

export function createPairingStore(db: Firestore, clock: () => number = Date.now) {
  const pairingRef = (id: string) => db.collection('officePairings').doc(id);
  const grantRef = (pairing: Pairing) =>
    db
      .collection('worlds')
      .doc(pairing.request.worldId)
      .collection('agentGrants')
      .doc(pairing.principalUid);

  async function ownsWorld(tx: Transaction, uid: string, worldId: string): Promise<boolean> {
    const [tester, world] = await tx.getAll(
      db.collection('testers').doc(uid),
      db.collection('worlds').doc(worldId)
    );
    const admission = tester.data();
    return (
      admission?.enabled === true &&
      Object.keys(admission).length === 1 &&
      world.data()?.ownerUid === uid
    );
  }

  async function current(tx: Transaction, id: string, now: number): Promise<Pairing> {
    const pairing = decode((await tx.get(pairingRef(id))).data(), id);
    active(pairing, now);
    if (!(await ownsWorld(tx, pairing.ownerUid, pairing.request.worldId))) unavailable();
    return pairing;
  }

  return {
    async approve(uid: string, request: Approval): Promise<ApprovedBinding> {
      // Random IDs are stable across transaction retries; no minting or delivery in tx.
      const principalUid = `office-agent:${randomUUID()}`;
      const blockId = randomUUID();
      return db.runTransaction(async (tx) => {
        const now = clock();
        if (!(await ownsWorld(tx, uid, request.worldId)))
          throw new PairingError('PERMISSION_DENIED');
        const existing = await tx.get(pairingRef(request.pairingId));
        if (existing.exists) {
          const pairing = decode(existing.data(), request.pairingId);
          if (pairing.ownerUid !== uid || !sameRequest(pairing.request, request))
            throw new PairingError('PAIRING_CONFLICT');
          active(pairing, now);
          if (pairing.claimed) validGrant((await tx.get(grantRef(pairing))).data(), pairing, now);
          return view(pairing);
        }
        const pairing: Pairing = {
          request,
          ownerUid: uid,
          principalUid,
          blockId,
          createdAt: Timestamp.fromMillis(now),
          expiresAt: Timestamp.fromMillis(now + APPROVAL_MS),
          enabled: true,
          claimed: false,
          nextClaimAt: Timestamp.fromMillis(now),
        };
        tx.create(pairingRef(request.pairingId), pairing);
        return view(pairing);
      });
    },

    async reserveClaim(id: string): Promise<ApprovedBinding> {
      return db.runTransaction(async (tx) => {
        const now = clock();
        const pairing = await current(tx, id, now);
        if (pairing.nextClaimAt.toMillis() > now) throw new PairingError('RETRY_LATER');
        const grant = await tx.get(grantRef(pairing));
        if (pairing.claimed) validGrant(grant.data(), pairing, now);
        else {
          if (grant.exists) unavailable();
          tx.create(grantRef(pairing), {
            version: 1,
            ownerUid: pairing.ownerUid,
            installationId: pairing.request.installationId,
            identityId: pairing.request.identityId,
            blockId: pairing.blockId,
            capabilities: pairing.request.capabilities,
            enabled: true,
            createdAt: Timestamp.fromMillis(now),
            expiresAt: Timestamp.fromMillis(now + GRANT_MS),
          });
        }
        tx.update(pairingRef(id), {
          claimed: true,
          nextClaimAt: Timestamp.fromMillis(now + CLAIM_INTERVAL_MS),
        });
        return view(pairing);
      });
    },

    async confirmClaim(id: string): Promise<void> {
      await db.runTransaction(async (tx) => {
        const now = clock();
        const pairing = await current(tx, id, now);
        if (!pairing.claimed) unavailable();
        validGrant((await tx.get(grantRef(pairing))).data(), pairing, now);
      });
    },

    async revoke(uid: string, id: string): Promise<void> {
      await db.runTransaction(async (tx) => {
        const snapshot = await tx.get(pairingRef(id));
        let pairing: Pairing;
        try {
          pairing = decode(snapshot.data(), id);
        } catch {
          throw new PairingError('PERMISSION_DENIED');
        }
        if (pairing.ownerUid !== uid || !(await ownsWorld(tx, uid, pairing.request.worldId)))
          throw new PairingError('PERMISSION_DENIED');
        const grant = await tx.get(grantRef(pairing));
        tx.update(pairingRef(id), { enabled: false });
        if (grant.exists) tx.update(grantRef(pairing), { enabled: false });
      });
    },
  };
}

export type PairingStore = ReturnType<typeof createPairingStore>;
