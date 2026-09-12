import { randomUUID } from 'node:crypto';
import { Timestamp } from 'firebase-admin/firestore';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import {
  APPROVAL_MS,
  CLAIM_INTERVAL_MS,
  GRANT_MS,
  isTimestampMillis,
  MAX_TIMESTAMP_MS,
  RENEWAL_WINDOW_MS,
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

export interface ClaimedBinding extends ApprovedBinding {
  grantExpiresAt: number;
}

export interface AgentIdentity {
  uid: string;
  installationId: string;
  identityId: string;
}

export type RevocationActor =
  | { kind: 'owner'; uid: string }
  | { kind: 'agent'; agent: AgentIdentity }
  | { kind: 'proof' };

function matchesAgent(pairing: Pairing, agent: AgentIdentity): boolean {
  return (
    pairing.principalUid === agent.uid &&
    pairing.request.installationId === agent.installationId &&
    pairing.request.identityId === agent.identityId
  );
}

export interface RenewedBinding {
  version: 1;
  pairingId: string;
  worldId: string;
  installationId: string;
  identityId: string;
  principalUid: string;
  blockId: string;
  capabilities: Approval['capabilities'];
  grantExpiresAt: number;
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

function timestampMillis(value: Timestamp): number {
  if (value.nanoseconds % 1_000_000 !== 0) unavailable();
  const millis = value.toMillis();
  if (!isTimestampMillis(millis)) unavailable();
  return millis;
}

function validApproval(pairing: Pairing, now: number, temporal: 'active' | 'renewal'): void {
  const createdAt = timestampMillis(pairing.createdAt);
  const expiresAt = timestampMillis(pairing.expiresAt);
  timestampMillis(pairing.nextClaimAt);
  if (
    !pairing.enabled ||
    createdAt > now ||
    expiresAt - createdAt !== APPROVAL_MS ||
    (temporal === 'active' && expiresAt <= now)
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

function validGrant(
  input: unknown,
  pairing: Pairing,
  now: number,
  temporal: 'active' | 'renewal' = 'active'
): number {
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
    const createdAt =
      value.createdAt instanceof Timestamp ? timestampMillis(value.createdAt) : unavailable();
    const expiresAt =
      value.expiresAt instanceof Timestamp ? timestampMillis(value.expiresAt) : unavailable();
    if (
      value.version !== 1 ||
      value.ownerUid !== pairing.ownerUid ||
      value.installationId !== pairing.request.installationId ||
      value.identityId !== pairing.request.identityId ||
      value.blockId !== pairing.blockId ||
      JSON.stringify(value.capabilities) !== JSON.stringify(pairing.request.capabilities) ||
      value.enabled !== true ||
      createdAt > now ||
      (temporal === 'active' && expiresAt <= now) ||
      expiresAt <= createdAt ||
      expiresAt - createdAt > GRANT_MS
    )
      unavailable();
    return expiresAt;
  } catch {
    unavailable();
  }
}

function renewed(pairing: Pairing, grantExpiresAt: number): RenewedBinding {
  return {
    version: 1,
    pairingId: pairing.request.pairingId,
    worldId: pairing.request.worldId,
    installationId: pairing.request.installationId,
    identityId: pairing.request.identityId,
    principalUid: pairing.principalUid,
    blockId: pairing.blockId,
    capabilities: pairing.request.capabilities,
    grantExpiresAt,
  };
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
    validApproval(pairing, now, 'active');
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
          validApproval(pairing, now, 'active');
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

    async reserveClaim(id: string): Promise<ClaimedBinding> {
      return db.runTransaction(async (tx) => {
        const now = clock();
        const pairing = await current(tx, id, now);
        if (pairing.nextClaimAt.toMillis() > now) throw new PairingError('RETRY_LATER');
        const grant = await tx.get(grantRef(pairing));
        const grantExpiresAt = pairing.claimed
          ? validGrant(grant.data(), pairing, now)
          : now + GRANT_MS;
        if (!pairing.claimed) {
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
            expiresAt: Timestamp.fromMillis(grantExpiresAt),
          });
        }
        tx.update(pairingRef(id), {
          claimed: true,
          nextClaimAt: Timestamp.fromMillis(now + CLAIM_INTERVAL_MS),
        });
        return { ...view(pairing), grantExpiresAt };
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

    async renew(
      agent: AgentIdentity,
      id: string,
      expectedGrantExpiresAt: number
    ): Promise<RenewedBinding> {
      return db.runTransaction(async (tx) => {
        const now = clock();
        if (!isTimestampMillis(now) || !isTimestampMillis(expectedGrantExpiresAt)) unavailable();
        const pairing = decode((await tx.get(pairingRef(id))).data(), id);
        validApproval(pairing, now, 'renewal');
        if (!pairing.claimed || !(await ownsWorld(tx, pairing.ownerUid, pairing.request.worldId)))
          unavailable();
        if (!matchesAgent(pairing, agent)) unavailable();

        const grant = await tx.get(grantRef(pairing));
        const currentGrantExpiresAt = validGrant(grant.data(), pairing, now, 'renewal');
        if (expectedGrantExpiresAt > currentGrantExpiresAt)
          throw new PairingError('PAIRING_CONFLICT');
        const withinRenewalWindow =
          currentGrantExpiresAt <= now || currentGrantExpiresAt - now <= RENEWAL_WINDOW_MS;
        if (expectedGrantExpiresAt < currentGrantExpiresAt || !withinRenewalWindow)
          return renewed(pairing, currentGrantExpiresAt);

        if (now > MAX_TIMESTAMP_MS - GRANT_MS) unavailable();
        const grantExpiresAt = now + GRANT_MS;
        tx.update(grant.ref, {
          createdAt: Timestamp.fromMillis(now),
          expiresAt: Timestamp.fromMillis(grantExpiresAt),
        });
        return renewed(pairing, grantExpiresAt);
      });
    },

    async revoke(actor: RevocationActor, id: string): Promise<void> {
      await db.runTransaction(async (tx) => {
        const snapshot = await tx.get(pairingRef(id));
        let pairing: Pairing;
        try {
          pairing = decode(snapshot.data(), id);
        } catch {
          throw new PairingError(
            actor.kind === 'owner' ? 'PERMISSION_DENIED' : 'PAIRING_UNAVAILABLE'
          );
        }
        if (actor.kind === 'owner') {
          if (
            pairing.ownerUid !== actor.uid ||
            !(await ownsWorld(tx, actor.uid, pairing.request.worldId))
          )
            throw new PairingError('PERMISSION_DENIED');
        } else if (
          actor.kind === 'agent' &&
          (!pairing.claimed || !matchesAgent(pairing, actor.agent))
        ) {
          unavailable();
        }
        const grant = await tx.get(grantRef(pairing));
        tx.update(pairingRef(id), { enabled: false });
        if (grant.exists) tx.update(grantRef(pairing), { enabled: false });
      });
    },
  };
}

export type PairingStore = ReturnType<typeof createPairingStore>;
