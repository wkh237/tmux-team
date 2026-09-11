import { randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { signInWithCustomToken } from 'firebase/auth';
import { doc, getDocFromServer, setDoc, serverTimestamp } from 'firebase/firestore';
import { createWorldPort } from '../src/worlds/firebase-worlds.js';
import { createFirestoreFixture, setTester } from './firestore-fixture.js';
import {
  parseClaim,
  parseApproval,
  CLAIM_INTERVAL_MS,
  APPROVAL_MS,
} from '../../../services/office/functions/src/pairing-contract.js';
import { createPairingStore } from '../../../services/office/functions/src/pairing-store.js';
import { createPairingService } from '../../../services/office/functions/src/pairing-service.js';
import { createPairingEmulatorFixture } from '../../../services/office/functions/test/emulator-fixture.js';

const endpoint = 'http://127.0.0.1:5001/demo-tmt-office/us-central1/officePairing';

async function post(operation: string, input: unknown, token?: string) {
  const response = await fetch(`${endpoint}/${operation}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(10_000),
  });
  expect(response.headers.get('cache-control')).toBe('no-store');
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function field(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value) throw new Error(`Missing response field ${key}`);
  return value;
}

async function withPairing(run: (context: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const fixture = await createFirestoreFixture();
  const admin = createPairingEmulatorFixture();
  try {
    await run(await setup(fixture, admin.db, admin.auth));
  } finally {
    try {
      await fixture.dispose();
    } finally {
      await admin.dispose();
    }
  }
}

async function setup(
  fixture: Awaited<ReturnType<typeof createFirestoreFixture>>,
  db: ReturnType<typeof createPairingEmulatorFixture>['db'],
  auth: ReturnType<typeof createPairingEmulatorFixture>['auth']
) {
  const owner = await fixture.client(true);
  const worlds = createWorldPort(owner.db);
  const world = worlds.draft('Pairing workshop');
  await worlds.create(world, owner.uid);
  const secret = randomBytes(32).toString('base64url');
  const pairingId = parseClaim({ version: 1, secret });
  const request = {
    version: 1,
    pairingId,
    worldId: world.id,
    installationId: crypto.randomUUID(),
    identityId: crypto.randomUUID(),
    installationLabel: 'Test installation',
    identityLabel: 'Alice',
    capabilities: ['layout.read', 'layout.write'],
  };
  const token = await owner.auth.currentUser!.getIdToken();
  return { fixture, db, auth, owner, world, secret, request, token };
}

test('HTTP approval and proof claim produce an actually usable scoped credential', async () => {
  await withPairing(async ({ fixture, db, owner, world, secret, request, token }) => {
    const approved = await post('approve', request, token);
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject(request);
    expect(approved.body).not.toHaveProperty('customToken');
    const repeated = await post('approve', request, token);
    expect(repeated).toEqual(approved);
    const claims = await Promise.all([
      post('claim', { version: 1, secret }),
      post('claim', { version: 1, secret }),
    ]);
    expect(claims.map((r) => r.status).sort()).toEqual([200, 429]);
    const claimed = claims.find((r) => r.status === 200)!.body;
    const principalUid = field(claimed, 'principalUid');
    const blockId = field(claimed, 'blockId');
    expect(principalUid).toBe(approved.body.principalUid);
    const agent = await fixture.client(false, 'device');
    await signInWithCustomToken(agent.auth, field(claimed, 'customToken'));
    expect(agent.auth.currentUser!.uid).toBe(principalUid);
    const target = doc(agent.db, 'worlds', world.id, 'blocks', blockId);
    await setDoc(target, {
      version: 1,
      revision: 1,
      objects: ['d000'],
      updatedAt: serverTimestamp(),
    });
    const stored = (
      await getDocFromServer(doc(owner.db, 'worlds', world.id, 'blocks', blockId))
    ).data();
    expect(stored?.objects).toEqual(['d000']);
    expect((await db.collection('worlds').doc(world.id).collection('agentGrants').get()).size).toBe(
      1
    );
    await expect(
      getDocFromServer(doc(agent.db, 'worlds', world.id, 'blocks', 'home'))
    ).rejects.toMatchObject({ code: 'permission-denied' });
    const revoked = await post('revoke', { version: 1, pairingId: request.pairingId }, token);
    expect(revoked).toEqual({
      status: 200,
      body: { version: 1, pairingId: request.pairingId, revoked: true },
    });
    await expect(getDocFromServer(target)).rejects.toMatchObject({ code: 'permission-denied' });
    expect(
      (await getDocFromServer(doc(owner.db, 'worlds', world.id, 'blocks', blockId))).data()
    ).toEqual(stored);
    expect((await post('claim', { version: 1, secret })).status).toBe(404);
    expect((await post('approve', request, token)).status).toBe(404);
  });
});

test('HTTP auth, input and proof failures cannot allocate credentials or cross owner scope', async () => {
  await withPairing(async ({ fixture, db, request, secret, token, owner }) => {
    expect((await post('approve', request)).status).toBe(401);
    expect((await post('approve', request, 'invalid-token')).status).toBe(401);
    for (const provider of ['google', 'unverified', 'device', 'anonymous'] as const) {
      const other = await fixture.client(true, provider);
      expect(
        (await post('approve', request, await other.auth.currentUser!.getIdToken())).status
      ).toBe(403);
    }
    expect((await post('approve', { ...request, ownerUid: owner.uid }, token)).status).toBe(400);
    expect(
      (await post('approve', { ...request, identityLabel: 'x'.repeat(5000) }, token)).status
    ).toBe(413);
    expect((await db.collection('officePairings').doc(request.pairingId).get()).exists).toBe(false);
    expect((await post('claim', { version: 1, secret })).status).toBe(404);
    expect((await post('approve', request, token)).status).toBe(200);
    expect(
      (await post('approve', { ...request, identityId: crypto.randomUUID() }, token)).status
    ).toBe(409);
    expect(
      (await post('claim', { version: 1, secret: randomBytes(32).toString('base64url') })).status
    ).toBe(404);
    await setTester(owner.uid, false);
    expect((await post('claim', { version: 1, secret })).status).toBe(404);
    expect((await post('approve', request, token)).status).toBe(403);
    expect((await post('revoke', { version: 1, pairingId: request.pairingId }, token)).status).toBe(
      403
    );
    expect(
      (await db.collection('worlds').doc(request.worldId).collection('agentGrants').get()).size
    ).toBe(0);
    await setTester(owner.uid, true);
    expect((await post('claim', { version: 1, secret })).status).toBe(200);
  });
});

test('expired approval remains revocable and a missing issued grant is never recreated', async () => {
  await withPairing(async ({ db, owner, request }) => {
    let now = Date.now();
    const store = createPairingStore(db, () => now);
    const input = parseApproval(request);
    const approved = await store.approve(owner.uid, input);
    await store.reserveClaim(request.pairingId);
    const grant = db
      .collection('worlds')
      .doc(request.worldId)
      .collection('agentGrants')
      .doc(approved.principalUid);
    await grant.delete();
    now += CLAIM_INTERVAL_MS;
    await expect(store.reserveClaim(request.pairingId)).rejects.toMatchObject({
      code: 'PAIRING_UNAVAILABLE',
    });
    await expect(store.approve(owner.uid, input)).rejects.toMatchObject({
      code: 'PAIRING_UNAVAILABLE',
    });
    expect((await grant.get()).exists).toBe(false);
    now += APPROVAL_MS;
    await store.revoke(owner.uid, request.pairingId);
    await store.revoke(owner.uid, request.pairingId);
    expect(
      (await db.collection('officePairings').doc(request.pairingId).get()).data()?.enabled
    ).toBe(false);
    expect((await grant.get()).exists).toBe(false);
    await expect(store.revoke(owner.uid, '0'.repeat(64))).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    const later = await store.approve(owner.uid, { ...input, pairingId: '1'.repeat(64) });
    await store.reserveClaim(later.pairingId);
    const retained = grant.parent.doc(later.principalUid);
    const before = (await retained.get()).data();
    expect(before?.enabled).toBe(true);
    now += APPROVAL_MS;
    await store.revoke(owner.uid, later.pairingId);
    expect((await retained.get()).data()).toEqual({ ...before, enabled: false });
  });
});

test('HTTP transport and malformed durable approval fail closed without state effects', async () => {
  await withPairing(async ({ db, request, secret, token }) => {
    for (const [method, origin, status] of [
      ['GET', 'http://127.0.0.1:4173', 405],
      ['POST', 'https://untrusted.example', 403],
    ] as const) {
      const response = await fetch(`${endpoint}/approve`, {
        method,
        headers: { origin, 'content-type': 'application/json', authorization: `Bearer ${token}` },
        ...(method === 'POST' ? { body: JSON.stringify(request) } : {}),
        signal: AbortSignal.timeout(10_000),
      });
      expect(response.status).toBe(status);
    }
    for (const [path, contentType, body, status] of [
      ['approve', 'text/plain', JSON.stringify(request), 400],
      ['approve', 'application/json', '{', 400],
      ['approve', 'application/json', '', 400],
      ['unknown', 'application/json', '{}', 404],
    ] as const) {
      const response = await fetch(`${endpoint}/${path}`, {
        method: 'POST',
        headers: { 'content-type': contentType, authorization: `Bearer ${token}` },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      // Malformed JSON is rejected by the platform before application dispatch.
      expect(response.status).toBe(status);
    }
    const record = db.collection('officePairings').doc(request.pairingId);
    expect((await record.get()).exists).toBe(false);
    expect((await post('approve', request, token)).status).toBe(200);
    await record.update({ unexpected: true });
    const malformed = (await record.get()).data();
    expect((await post('claim', { version: 1, secret })).status).toBe(404);
    expect((await post('approve', request, token)).status).toBe(404);
    expect((await record.get()).data()).toEqual(malformed);
    expect(
      (await db.collection('worlds').doc(request.worldId).collection('agentGrants').get()).empty
    ).toBe(true);
  });
});

test('signer failure and lost-response retries preserve one principal and the original grant lease', async () => {
  await withPairing(async ({ db, auth, owner, request, secret, token }) => {
    let now = Date.now();
    const store = createPairingStore(db, () => now);
    let fail = true;
    const service = createPairingService(store, {
      verifyIdToken: (value, revoked) => auth.verifyIdToken(value, revoked),
      createCustomToken: (uid, claims) => {
        if (fail) throw new Error('Injected signer failure; no credential disclosure');
        return auth.createCustomToken(uid, claims);
      },
    });
    const approved = await service.approve(request, `Bearer ${token}`);
    await expect(service.claim({ version: 1, secret })).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    const grants = db.collection('worlds').doc(request.worldId).collection('agentGrants');
    const original = (await grants.doc(approved.principalUid).get()).data();
    expect(original?.enabled).toBe(true);
    fail = false;
    now += CLAIM_INTERVAL_MS;
    const recovered = await service.claim({ version: 1, secret });
    expect(recovered.principalUid).toBe(approved.principalUid);
    now += CLAIM_INTERVAL_MS;
    expect((await service.claim({ version: 1, secret })).principalUid).toBe(approved.principalUid);
    expect((await grants.get()).size).toBe(1);
    expect((await grants.doc(approved.principalUid).get()).data()).toEqual(original);
    await store.revoke(owner.uid, request.pairingId);
    now += CLAIM_INTERVAL_MS;
    await expect(service.claim({ version: 1, secret })).rejects.toMatchObject({
      code: 'PAIRING_UNAVAILABLE',
    });
  });
});

test('approval expiry and revocation during signing prevent credential delivery', async () => {
  await withPairing(async ({ db, auth, owner, request, secret, token }) => {
    let now = Date.now();
    const store = createPairingStore(db, () => now);
    const service = createPairingService(store, {
      verifyIdToken: (value, revoked) => auth.verifyIdToken(value, revoked),
      createCustomToken: async (uid, claims) => {
        const credential = await auth.createCustomToken(uid, claims);
        await store.revoke(owner.uid, request.pairingId);
        return credential;
      },
    });
    const approved = await service.approve(request, `Bearer ${token}`);
    await expect(service.claim({ version: 1, secret })).rejects.toMatchObject({
      code: 'PAIRING_UNAVAILABLE',
    });
    const grant = await db
      .collection('worlds')
      .doc(request.worldId)
      .collection('agentGrants')
      .doc(approved.principalUid)
      .get();
    expect(grant.data()?.enabled).toBe(false);
    const newSecret = randomBytes(32).toString('base64url');
    const newRequest = { ...request, pairingId: parseClaim({ version: 1, secret: newSecret }) };
    const expiring = await store.approve(owner.uid, parseApproval(newRequest));
    now += APPROVAL_MS;
    await expect(store.reserveClaim(expiring.pairingId)).rejects.toMatchObject({
      code: 'PAIRING_UNAVAILABLE',
    });
    expect(
      (
        await db
          .collection('worlds')
          .doc(request.worldId)
          .collection('agentGrants')
          .doc(expiring.principalUid)
          .get()
      ).exists
    ).toBe(false);
  });
});
