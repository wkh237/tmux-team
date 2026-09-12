import { Timestamp } from 'firebase-admin/firestore';
import type { DecodedIdToken } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { APPROVAL_MS, GRANT_MS, RENEWAL_WINDOW_MS } from '../src/pairing-contract.js';
import { createPairingStore } from '../src/pairing-store.js';
import type { PairingAuthentication } from '../src/pairing-service.js';
import { createPairingService } from '../src/pairing-service.js';
import type { PairingStore } from '../src/pairing-store.js';

const OWNER = 'owner-uid';
const WORLD = 'abcdefghijklmnopqrst';
const PAIRING = 'a'.repeat(64);
const PRINCIPAL = 'office-agent:00000000-0000-4000-8000-000000000001';
const INSTALLATION = '00000000-0000-4000-8000-000000000002';
const IDENTITY = '00000000-0000-4000-8000-000000000003';
const BLOCK = '00000000-0000-4000-8000-000000000004';
const NOW = 1_700_000_000_000;

type Ref = { path: string; id: string; collection(name: string): Ref; doc(id: string): Ref };

function reference(path: string): Ref {
  const parts = path.split('/');
  const ref = {
    path,
    id: parts.at(-1)!,
    collection(name: string) {
      return reference(`${path}/${name}`);
    },
    doc(id: string) {
      return reference(`${path}/${id}`);
    },
  };
  return ref;
}

function fakeFirestore(initial: Record<string, unknown>) {
  const values = new Map(Object.entries(initial));
  const updates: Array<{ path: string; value: Record<string, unknown> }> = [];
  const snapshot = (ref: Ref) => ({
    ref,
    exists: values.has(ref.path),
    data: () => values.get(ref.path),
  });
  const db = {
    collection: (name: string) => reference(name),
    runTransaction: async (operation: (transaction: unknown) => Promise<unknown>) =>
      operation({
        get: async (ref: Ref) => snapshot(ref),
        getAll: async (...refs: Ref[]) => refs.map((ref) => snapshot(ref)),
        update: (ref: Ref, value: Record<string, unknown>) => {
          const current = values.get(ref.path);
          values.set(ref.path, { ...(current as Record<string, unknown>), ...value });
          updates.push({ path: ref.path, value });
        },
      }),
  };
  return { db: db as unknown as Firestore, values, updates };
}

function seed(
  grantExpiresAt: number,
  options: {
    pairingEnabled?: boolean;
    claimed?: boolean;
    ownerAdmitted?: boolean;
    requestPatch?: Record<string, unknown>;
    pairingPatch?: Record<string, unknown>;
    grant?: Record<string, unknown>;
    missingGrant?: boolean;
  } = {}
) {
  const pairing = {
    request: {
      version: 1 as const,
      pairingId: PAIRING,
      worldId: WORLD,
      installationId: INSTALLATION,
      identityId: IDENTITY,
      installationLabel: 'Installation',
      identityLabel: 'Alice',
      capabilities: ['layout.read', 'layout.write'] as ['layout.read', 'layout.write'],
      ...options.requestPatch,
    },
    ownerUid: OWNER,
    principalUid: PRINCIPAL,
    blockId: BLOCK,
    createdAt: Timestamp.fromMillis(NOW - APPROVAL_MS),
    expiresAt: Timestamp.fromMillis(NOW),
    enabled: options.pairingEnabled ?? true,
    claimed: options.claimed ?? true,
    nextClaimAt: Timestamp.fromMillis(NOW),
    ...options.pairingPatch,
  };
  const grant = {
    version: 1,
    ownerUid: OWNER,
    installationId: INSTALLATION,
    identityId: IDENTITY,
    blockId: BLOCK,
    capabilities: ['layout.read', 'layout.write'],
    enabled: true,
    createdAt: Timestamp.fromMillis(grantExpiresAt - GRANT_MS),
    expiresAt: Timestamp.fromMillis(grantExpiresAt),
    ...options.grant,
  };
  const initial: Record<string, unknown> = {
    [`officePairings/${PAIRING}`]: pairing,
    [`worlds/${WORLD}`]: { ownerUid: OWNER },
  };
  if (options.ownerAdmitted !== false) initial[`testers/${OWNER}`] = { enabled: true };
  if (!options.missingGrant) initial[`worlds/${WORLD}/agentGrants/${PRINCIPAL}`] = grant;
  return fakeFirestore(initial);
}

const agent = { uid: PRINCIPAL, installationId: INSTALLATION, identityId: IDENTITY };

describe('renewal authentication', () => {
  it('requires a checked agent token and returns only the exact public lease view', async () => {
    let observed: unknown[] | undefined;
    const response = {
      version: 1 as const,
      pairingId: PAIRING,
      worldId: WORLD,
      installationId: INSTALLATION,
      identityId: IDENTITY,
      principalUid: PRINCIPAL,
      blockId: BLOCK,
      capabilities: ['layout.read'] as ['layout.read'],
      grantExpiresAt: NOW + GRANT_MS,
    };
    const auth: PairingAuthentication = {
      verifyIdToken: async (token, checkRevoked) => {
        expect(token).toBe('agent-token');
        expect(checkRevoked).toBe(true);
        return {
          uid: PRINCIPAL,
          tmtOfficeAgent: true,
          tmtInstallationId: INSTALLATION,
          tmtIdentityId: IDENTITY,
        } as unknown as DecodedIdToken;
      },
      createCustomToken: async () => 'unused',
    };
    const store = {
      renew: async (...args: unknown[]) => {
        observed = args;
        return response;
      },
    } as unknown as PairingStore;
    const service = createPairingService(store, auth);

    await expect(
      service.renew({ version: 1, pairingId: PAIRING, grantExpiresAt: NOW }, 'Bearer agent-token')
    ).resolves.toEqual(response);
    expect(observed).toEqual([
      { uid: PRINCIPAL, installationId: INSTALLATION, identityId: IDENTITY },
      PAIRING,
      NOW,
    ]);
  });

  it.each([
    { tmtOfficeAgent: false },
    { tmtInstallationId: 'not-a-uuid' },
    { tmtIdentityId: 'not-a-uuid' },
  ])('rejects a non-agent or malformed custom claim %j', async (claims) => {
    const auth: PairingAuthentication = {
      verifyIdToken: async () =>
        ({
          uid: PRINCIPAL,
          tmtOfficeAgent: true,
          tmtInstallationId: INSTALLATION,
          tmtIdentityId: IDENTITY,
          ...claims,
        }) as unknown as DecodedIdToken,
      createCustomToken: async () => 'unused',
    };
    const store = { renew: async () => responseForTest() } as unknown as PairingStore;

    await expect(
      createPairingService(store, auth).renew(
        { version: 1, pairingId: PAIRING, grantExpiresAt: NOW },
        'Bearer agent-token'
      )
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

function responseForTest() {
  return {
    version: 1 as const,
    pairingId: PAIRING,
    worldId: WORLD,
    installationId: INSTALLATION,
    identityId: IDENTITY,
    principalUid: PRINCIPAL,
    blockId: BLOCK,
    capabilities: ['layout.read'] as ['layout.read'],
    grantExpiresAt: NOW + GRANT_MS,
  };
}

describe('renewal store', () => {
  it.each([0, Number.MAX_SAFE_INTEGER])('rejects an impossible renewal clock %s', async (now) => {
    const fixture = seed(NOW - 1);
    const store = createPairingStore(fixture.db, () => now);

    await expect(store.renew(agent, PAIRING, NOW - 1)).rejects.toMatchObject({
      code: 'PAIRING_UNAVAILABLE',
    });
    expect(fixture.updates).toHaveLength(0);
  });

  it('renews an expired lease without changing its resource binding', async () => {
    const fixture = seed(NOW - 1);
    const store = createPairingStore(fixture.db, () => NOW);

    const renewed = await store.renew(agent, PAIRING, NOW - 1);

    expect(renewed).toEqual({
      version: 1,
      pairingId: PAIRING,
      worldId: WORLD,
      installationId: INSTALLATION,
      identityId: IDENTITY,
      principalUid: PRINCIPAL,
      blockId: BLOCK,
      capabilities: ['layout.read', 'layout.write'],
      grantExpiresAt: NOW + GRANT_MS,
    });
    expect(fixture.updates).toHaveLength(1);
    expect(fixture.values.get(`worlds/${WORLD}/agentGrants/${PRINCIPAL}`)).toMatchObject({
      ownerUid: OWNER,
      installationId: INSTALLATION,
      identityId: IDENTITY,
      blockId: BLOCK,
      capabilities: ['layout.read', 'layout.write'],
      createdAt: Timestamp.fromMillis(NOW),
      expiresAt: Timestamp.fromMillis(NOW + GRANT_MS),
    });
  });

  it('returns a newer live lease for stale expectations without extending it', async () => {
    const current = NOW + 60_000;
    const fixture = seed(current);
    const store = createPairingStore(fixture.db, () => NOW);

    await expect(store.renew(agent, PAIRING, NOW - 1)).resolves.toMatchObject({
      grantExpiresAt: current,
    });
    expect(fixture.updates).toHaveLength(0);
  });

  it('returns an expired current lease for a stale retry instead of extending it', async () => {
    const current = NOW - 1;
    const fixture = seed(current);
    const store = createPairingStore(fixture.db, () => NOW);

    await expect(store.renew(agent, PAIRING, NOW - 2)).resolves.toMatchObject({
      grantExpiresAt: current,
    });
    expect(fixture.updates).toHaveLength(0);
  });

  it.each([
    [RENEWAL_WINDOW_MS, 1],
    [RENEWAL_WINDOW_MS + 1, 0],
  ])(
    'renews only when an equal expectation is within the five-minute window (%s)',
    async (offset, updates) => {
      const current = NOW + offset;
      const fixture = seed(current);
      const store = createPairingStore(fixture.db, () => NOW);

      await store.renew(agent, PAIRING, current);

      expect(fixture.updates).toHaveLength(updates);
    }
  );

  it('rejects higher expectations and mismatched agent claims', async () => {
    const fixture = seed(NOW - 1);
    const store = createPairingStore(fixture.db, () => NOW);
    await expect(store.renew(agent, PAIRING, NOW + 1)).rejects.toMatchObject({
      code: 'PAIRING_CONFLICT',
    });
    for (const mismatch of [
      { ...agent, uid: `${PRINCIPAL}-other` },
      { ...agent, installationId: IDENTITY },
      { ...agent, identityId: INSTALLATION },
    ]) {
      await expect(store.renew(mismatch, PAIRING, NOW - 1)).rejects.toMatchObject({
        code: 'PAIRING_UNAVAILABLE',
      });
    }
  });

  it.each([
    ['disabled pairing', { pairingEnabled: false }],
    ['unclaimed approval', { claimed: false }],
    ['owner admission removed', { ownerAdmitted: false }],
    ['malformed approval', { requestPatch: { worldId: 'bad-world' } }],
    ['disabled grant', { grant: { enabled: false } }],
    ['missing grant', { missingGrant: true }],
    ['malformed grant', { grant: { extra: true } }],
    [
      'fractional grant timestamp',
      {
        grant: {
          createdAt: new Timestamp(
            Timestamp.fromMillis(NOW - GRANT_MS).seconds,
            Timestamp.fromMillis(NOW - GRANT_MS).nanoseconds + 1
          ),
        },
      },
    ],
    [
      'fractional approval timestamp',
      {
        pairingPatch: {
          createdAt: new Timestamp(
            Timestamp.fromMillis(NOW - APPROVAL_MS).seconds,
            Timestamp.fromMillis(NOW - APPROVAL_MS).nanoseconds + 1
          ),
        },
      },
    ],
  ])('%s cannot be renewed or recreated', async (_name, options) => {
    const fixture = seed(NOW - 1, options);
    const hasGrant = !('missingGrant' in options && options.missingGrant);
    const store = createPairingStore(fixture.db, () => NOW);

    await expect(store.renew(agent, PAIRING, NOW - 1)).rejects.toMatchObject({
      code: 'PAIRING_UNAVAILABLE',
    });
    expect(fixture.updates).toHaveLength(0);
    expect(fixture.values.has(`worlds/${WORLD}/agentGrants/${PRINCIPAL}`)).toBe(hasGrant);
  });
});
