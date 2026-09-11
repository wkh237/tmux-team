import { test, expect } from '@playwright/test';
import {
  collection,
  deleteDoc,
  doc,
  getDocFromServer,
  getDocsFromServer,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { createWorldPort } from '../src/worlds/firebase-worlds.js';
import { createFirestoreFixture, setTester, writeAgentGrantFields } from './firestore-fixture.js';

async function withAssignment(
  run: (setup: Awaited<ReturnType<typeof assignment>>) => Promise<void>
): Promise<void> {
  const fixture = await createFirestoreFixture();
  try {
    await run(await assignment(fixture));
  } finally {
    await fixture.dispose();
  }
}

async function assignment(fixture: Awaited<ReturnType<typeof createFirestoreFixture>>) {
  const owner = await fixture.client(true);
  const installationId = crypto.randomUUID();
  const identityId = crypto.randomUUID();
  const claims = {
    tmtOfficeAgent: true,
    tmtInstallationId: installationId,
    tmtIdentityId: identityId,
  };
  const agent = await fixture.client(false, 'device', claims);
  const worlds = createWorldPort(owner.db);
  const world = worlds.draft('Scoped studio');
  await worlds.create(world, owner.uid);
  const blockId = crypto.randomUUID();
  const createdAt = Date.now() - 60_000;
  // Literal wire values are an independent operator oracle, not a product codec.
  const fields: Record<string, unknown> = {
    version: { integerValue: '1' },
    ownerUid: { stringValue: owner.uid },
    installationId: { stringValue: installationId },
    identityId: { stringValue: identityId },
    blockId: { stringValue: blockId },
    capabilities: {
      arrayValue: { values: [{ stringValue: 'layout.read' }, { stringValue: 'layout.write' }] },
    },
    enabled: { booleanValue: true },
    createdAt: { timestampValue: new Date(createdAt).toISOString() },
    expiresAt: { timestampValue: new Date(createdAt + 86_400_000).toISOString() },
  };
  await writeAgentGrantFields(world.id, agent.uid, fields);
  return {
    fixture,
    owner,
    agent,
    world,
    blockId,
    fields,
    claims,
    createdAt,
    agentBlock: doc(agent.db, 'worlds', world.id, 'blocks', blockId),
    ownerBlock: doc(owner.db, 'worlds', world.id, 'blocks', blockId),
    ownerGrant: doc(owner.db, 'worlds', world.id, 'agentGrants', agent.uid),
  };
}

const layout = (revision: number, objects: string[] = ['d000']) => ({
  version: 1,
  revision,
  objects,
  updatedAt: serverTimestamp(),
});
const denied = (operation: Promise<unknown>) =>
  expect(operation).rejects.toMatchObject({ code: 'permission-denied' });

test('an assigned principal edits only its block with the existing bounded revision contract', async () => {
  await withAssignment(
    async ({ fixture, owner, agent, world, blockId, agentBlock, ownerBlock, claims }) => {
      expect((await getDocFromServer(agentBlock)).exists()).toBe(false);
      // Exercise the full Rules expression budget on both create and update.
      await setDoc(agentBlock, layout(1, Array(16).fill('d000')));
      expect((await getDocFromServer(ownerBlock)).data()?.objects).toHaveLength(16);
      await setDoc(agentBlock, layout(2, Array(16).fill('p000')));
      const stored = (await getDocFromServer(ownerBlock)).data();
      expect(stored?.revision).toBe(2);
      for (const invalid of [
        layout(2),
        layout(4),
        layout(3, Array(17).fill('d000')),
        layout(3, [...Array(15).fill('d000'), 'd0v0']),
        { ...layout(3), ownerUid: agent.uid },
        { ...layout(3), updatedAt: 0 },
      ])
        await denied(setDoc(agentBlock, invalid));
      await denied(deleteDoc(agentBlock));
      for (const otherBlock of ['home', crypto.randomUUID()]) {
        const target = doc(agent.db, 'worlds', world.id, 'blocks', otherBlock);
        await denied(getDocFromServer(target));
        await denied(setDoc(target, layout(1)));
      }
      // Copying even valid binding labels cannot substitute for the granted UID.
      const other = await fixture.client(false, 'device', claims);
      await denied(getDocFromServer(doc(other.db, 'worlds', world.id, 'blocks', blockId)));
      const secondWorld = createWorldPort(owner.db).draft('Separate world');
      await createWorldPort(owner.db).create(secondWorld, owner.uid);
      await denied(setDoc(doc(agent.db, 'worlds', secondWorld.id, 'blocks', blockId), layout(1)));
      expect((await getDocFromServer(ownerBlock)).data()).toEqual(stored);
    }
  );
});

test('layout grants confer no world, grant, notebook, profile, board or work authority', async () => {
  await withAssignment(async ({ agent, world, agentBlock, ownerBlock }) => {
    await setDoc(agentBlock, layout(1));
    await denied(getDocFromServer(doc(agent.db, 'worlds', world.id)));
    for (const path of ['agentGrants', 'notebooks', 'profiles', 'board', 'messages', 'exchanges']) {
      const target = doc(agent.db, 'worlds', world.id, path, agent.uid);
      await denied(getDocFromServer(target));
      await denied(setDoc(target, { enabled: true }));
    }
    await denied(getDocsFromServer(collection(agent.db, 'worlds', world.id, 'blocks')));
    expect((await getDocFromServer(ownerBlock)).data()?.revision).toBe(1);
  });
});

test('a read-only grant cannot mutate even its own assigned layout', async () => {
  await withAssignment(async ({ agent, world, fields, agentBlock, ownerBlock }) => {
    await setDoc(ownerBlock, layout(1));
    await writeAgentGrantFields(world.id, agent.uid, {
      ...fields,
      capabilities: { arrayValue: { values: [{ stringValue: 'layout.read' }] } },
    });
    const stored = (await getDocFromServer(agentBlock)).data();
    expect(stored?.objects).toEqual(['d000']);
    await denied(setDoc(agentBlock, layout(2, [])));
    expect((await getDocFromServer(ownerBlock)).data()).toEqual(stored);
  });
});

test('malformed or expired grants fail closed with the same authenticated token', async () => {
  await withAssignment(async ({ agent, world, fields, agentBlock, ownerBlock, createdAt }) => {
    await setDoc(agentBlock, layout(1));
    const token = await agent.auth.currentUser!.getIdToken();
    const stored = (await getDocFromServer(ownerBlock)).data();
    const mutations: Record<string, unknown>[] = [
      { version: { integerValue: '2' } },
      { version: { doubleValue: 1 } },
      { extra: { booleanValue: true } },
      { ownerUid: { stringValue: 'another-owner' } },
      { installationId: { stringValue: 'copied-label' } },
      { installationId: { stringValue: crypto.randomUUID() } },
      { identityId: { stringValue: 'alice' } },
      { identityId: { stringValue: crypto.randomUUID() } },
      { blockId: { stringValue: 'home' } },
      { enabled: { booleanValue: false } },
      { enabled: { stringValue: 'true' } },
      { expiresAt: { timestampValue: new Date(Date.now() - 1000).toISOString() } },
      { expiresAt: { timestampValue: new Date(createdAt + 86_400_001).toISOString() } },
      { expiresAt: { integerValue: '9999999999999' } },
      { createdAt: { timestampValue: new Date(Date.now() + 60_000).toISOString() } },
      { capabilities: { arrayValue: { values: [{ stringValue: 'layout.write' }] } } },
      {
        capabilities: {
          arrayValue: { values: [{ stringValue: 'layout.read' }, { stringValue: 'board.write' }] },
        },
      },
    ];
    for (const changes of mutations) {
      await writeAgentGrantFields(world.id, agent.uid, { ...fields, ...changes });
      await denied(getDocFromServer(agentBlock));
      await denied(setDoc(agentBlock, layout(2, [])));
    }
    for (const key of Object.keys(fields)) {
      const incomplete = { ...fields };
      delete incomplete[key];
      await writeAgentGrantFields(world.id, agent.uid, incomplete);
      await denied(getDocFromServer(agentBlock));
    }
    await writeAgentGrantFields(world.id, agent.uid, fields);
    expect((await getDocFromServer(agentBlock)).data()).toEqual(stored);
    expect(await agent.auth.currentUser!.getIdToken()).toBe(token);
  });
});

test('client identities cannot mint grants or impersonate the scoped custom principal', async () => {
  await withAssignment(
    async ({
      fixture,
      owner,
      agent,
      world,
      fields,
      blockId,
      agentBlock,
      ownerBlock,
      ownerGrant,
      claims,
    }) => {
      await setDoc(agentBlock, layout(1));
      const grant = (await getDocFromServer(ownerGrant)).data()!;
      const actors = [
        owner,
        agent,
        await fixture.client(true),
        await fixture.client(true, 'device'),
        await fixture.client(false, 'device', { ...claims, tmtOfficeAgent: 'true' }),
        await fixture.client(false, 'device', { ...claims, tmtOfficeAgent: false }),
        await fixture.client(false, 'anonymous'),
      ];
      for (const actor of actors) {
        await denied(
          setDoc(doc(actor.db, 'worlds', world.id, 'agentGrants', crypto.randomUUID()), grant)
        );
        await denied(deleteDoc(doc(actor.db, 'worlds', world.id, 'agentGrants', agent.uid)));
        await denied(getDocsFromServer(collection(actor.db, 'worlds', world.id, 'agentGrants')));
      }
      // Even an operator-created record is insufficient for a human, anonymous
      // user or an unrelated custom-token role. Approved tester status is no bypass.
      for (const actor of actors.slice(2)) {
        await writeAgentGrantFields(world.id, actor.uid, fields);
        const target = doc(actor.db, 'worlds', world.id, 'blocks', blockId);
        await denied(getDocFromServer(target));
        await denied(setDoc(target, layout(2)));
        await denied(
          updateDoc(doc(actor.db, 'worlds', world.id, 'agentGrants', agent.uid), { enabled: false })
        );
      }
      await denied(
        updateDoc(doc(agent.db, 'worlds', world.id, 'agentGrants', agent.uid), { enabled: false })
      );
      expect((await getDocFromServer(ownerBlock)).data()?.revision).toBe(1);
      expect((await getDocFromServer(ownerGrant)).data()).toEqual(grant);
    }
  );
});

test('owner revocation is one-way, denies cached credentials and retains the exact block', async () => {
  await withAssignment(
    async ({ agent, owner, world, fields, agentBlock, ownerBlock, ownerGrant }) => {
      await setDoc(agentBlock, layout(1));
      const token = await agent.auth.currentUser!.getIdToken();
      const stored = (await getDocFromServer(ownerBlock)).data();
      const grant = (await getDocFromServer(ownerGrant)).data();
      for (const changes of [
        { blockId: crypto.randomUUID() },
        { identityId: crypto.randomUUID() },
        { installationId: crypto.randomUUID() },
        { ownerUid: agent.uid },
        { capabilities: ['layout.read'] },
        { expiresAt: serverTimestamp() },
        { enabled: false, blockId: crypto.randomUUID() },
      ])
        await denied(updateDoc(ownerGrant, changes));
      expect((await getDocFromServer(ownerGrant)).data()).toEqual(grant);
      await updateDoc(ownerGrant, { enabled: false });
      await denied(getDocFromServer(agentBlock));
      await denied(setDoc(agentBlock, layout(2)));
      await denied(updateDoc(ownerGrant, { enabled: true }));
      expect(await agent.auth.currentUser!.getIdToken()).toBe(token);
      expect((await getDocFromServer(ownerBlock)).data()).toEqual(stored);
      expect((await getDocFromServer(ownerGrant)).data()).toEqual({ ...grant, enabled: false });
      // Test tester revocation independently, not masked by an already-disabled grant.
      await writeAgentGrantFields(world.id, agent.uid, fields);
      expect((await getDocFromServer(agentBlock)).data()).toEqual(stored);
      await setTester(owner.uid, false);
      await denied(getDocFromServer(agentBlock));
      await denied(setDoc(agentBlock, layout(2)));
      await denied(getDocFromServer(ownerBlock));
      await setTester(owner.uid, true);
      expect((await getDocFromServer(ownerBlock)).data()).toEqual(stored);
      expect((await getDocFromServer(agentBlock)).data()).toEqual(stored);
      // Fail-closed recovery may disable a malformed record without repairing it.
      await writeAgentGrantFields(world.id, agent.uid, {
        ...fields,
        extra: { booleanValue: true },
      });
      await denied(getDocFromServer(agentBlock));
      await updateDoc(ownerGrant, { enabled: false });
      expect((await getDocFromServer(ownerGrant)).data()).toEqual({
        ...grant,
        extra: true,
        enabled: false,
      });
      expect((await getDocFromServer(ownerBlock)).data()).toEqual(stored);
    }
  );
});
