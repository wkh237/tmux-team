import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test, signIn } from './browser-session.js';
import { setTester } from './firestore-fixture.js';
import { createPairingEmulatorFixture } from '../../../services/office/functions/test/emulator-fixture.js';
import { createArtifact } from '../../../test/support/native-artifact.js';
import { runCli, withSandbox } from '../../../test/support/cli-process.js';

test('native pairing resumes its protected proof and a separate process uses the scoped credential', async ({
  openSession,
}) => {
  test.setTimeout(90_000);
  const admin = createPairingEmulatorFixture();
  try {
    await withSandbox(async (sandbox) => {
      let scopeKey: string | undefined;
      const vault = async (operation: 'lookup' | 'store' | 'clear', input?: string) => {
        if (!scopeKey) throw new Error('The scenario has no protected scope yet.');
        return runCli(
          { ...sandbox, cli: { executable: '/usr/bin/secret-tool', args: [] } },
          [
            operation,
            ...(operation === 'store' ? ['--label', 'Native pairing fixture'] : []),
            'service',
            'org.tmux-team.office.v1',
            'username',
            scopeKey,
          ],
          input === undefined ? {} : { stdin: input }
        );
      };
      try {
        const companion = path.resolve('../../rust/target/debug/tmt-office');
        const fixture = await createArtifact(
          sandbox,
          '0.1.0-alpha.1',
          new Uint8Array(),
          'office',
          companion
        );
        const prefix = path.join(sandbox.root, 'office-prefix');
        const installed = await runCli(
          sandbox,
          [
            'office',
            'install',
            '--yes',
            '--prefix',
            prefix,
            '--archive',
            fixture.archive,
            '--manifest',
            fixture.manifest,
            '--json',
          ],
          { deadlineMs: 20_000 }
        );
        expect(installed.status, installed.stdout).toBe(0);
        expect(installed.stderr).toBe('');
        const created = await runCli(sandbox, ['identity', 'create', 'Alice', '--json']);
        expect(created.status, created.stdout).toBe(0);
        const worldId = admin.db.collection('worlds').doc().id;
        const world = `http://127.0.0.1:4173/worlds/${worldId}`;
        const office = (operation: string, extra: string[] = [], env = sandbox.env) =>
          runCli(
            { ...sandbox, env },
            [
              'office',
              operation,
              '--prefix',
              prefix,
              '--world',
              world,
              '--identity',
              'Alice',
              '--emulator',
              '--json',
              ...extra,
            ],
            { deadlineMs: 35_000 }
          );
        const unpaired = await office('status');
        expect(unpaired.status).toBe(0);
        expect(JSON.parse(unpaired.stdout).state).toBe('unpaired');
        const unpairedRead = await office('inspect');
        expect(unpairedRead.status).toBe(1);
        expect(JSON.parse(unpairedRead.stdout).error.code).toBe('OFFICE_NOT_PAIRED');
        const unavailable = await office('pair', ['--timeout', '5'], {
          ...sandbox.env,
          DBUS_SESSION_BUS_ADDRESS: `unix:path=${sandbox.root}/missing-session-bus`,
        });
        expect(unavailable.status).toBe(1);
        expect(JSON.parse(unavailable.stdout).error.code).toBe('OFFICE_CREDENTIALS_UNAVAILABLE');
        expect(unavailable.stderr).toBe('');

        // End the observer before approval, then resume from another CLI process.
        // This is an explicit short observer window, not a fixed readiness sleep.
        const pending = await office('pair', ['--timeout', '5']);
        expect(pending.status, pending.stdout).toBe(1);
        expect(JSON.parse(pending.stdout).error.code).toBe('OFFICE_PAIRING_PENDING');
        const link = pending.stderr.trim();
        expect(link.startsWith(`${world}/pair#tmt-pair=`)).toBe(true);
        const consent = JSON.parse(
          Buffer.from(link.split('#tmt-pair=')[1]!, 'base64url').toString('utf8')
        ) as Record<string, unknown>;
        expect(Object.keys(consent).sort()).toEqual(
          [
            'capabilities',
            'identityId',
            'identityLabel',
            'installationId',
            'installationLabel',
            'pairingId',
            'version',
            'worldId',
          ].sort()
        );
        expect(consent.identityLabel).toBe('Alice');
        expect(consent.capabilities).toEqual(['layout.read', 'layout.write']);
        const installationId = readFileSync(
          path.join(sandbox.globalDir, 'office', 'installation-id'),
          'utf8'
        );
        const scopeFile = readdirSync(path.join(sandbox.globalDir, 'office')).find((name) =>
          /^[0-9a-f]{64}\.lock$/.test(name)
        );
        expect(scopeFile).toBeDefined();
        scopeKey = scopeFile!.slice(0, -'.lock'.length);
        const protectedPending = await vault('lookup');
        expect(protectedPending.status).toBe(0);
        const pendingRecord = JSON.parse(protectedPending.stdout);
        expect(pendingRecord.phase.state).toBe('pending');
        const proof: string = pendingRecord.phase.secret;
        expect(createHash('sha256').update(Buffer.from(proof, 'base64url')).digest('hex')).toBe(
          consent.pairingId
        );
        expect(consent.installationId).toBe(installationId);
        const pairing = admin.db.collection('officePairings').doc(String(consent.pairingId));
        expect((await pairing.get()).exists).toBe(false);
        const changedCapabilities = await office('pair', ['--read-only', '--timeout', '5']);
        expect(changedCapabilities.status).toBe(1);
        expect(JSON.parse(changedCapabilities.stdout).error.code).toBe(
          'OFFICE_CREDENTIALS_INVALID'
        );
        expect(changedCapabilities.stderr).toBe('');
        expect((await vault('lookup')).stdout === protectedPending.stdout).toBe(true);

        const { page } = await openSession(link);
        await signIn(page, 'NativeOfficeOwner');
        const uid = (await page.getByText(/^UID: /).innerText()).replace(/^UID: /, '').trim();
        await admin.db
          .collection('worlds')
          .doc(worldId)
          .set({ version: 1, name: 'Native office', ownerUid: uid, createdAt: new Date() });
        await setTester(uid, true);
        await expect(page.getByRole('region', { name: 'Agent pairing request' })).toBeVisible();
        await page
          .getByRole('checkbox', { name: 'I recognize this agent and installation.' })
          .check();
        await page.getByRole('button', { name: 'Approve pairing', exact: true }).click();
        await expect(
          page.getByRole('status').filter({ hasText: 'Approved. Return' })
        ).toBeVisible();
        const resumed = await office('pair', ['--timeout', '25']);
        expect(resumed.status, resumed.stdout).toBe(0);
        expect(resumed.stderr.trim()).toBe(link);
        expect(JSON.parse(resumed.stdout).state).toBe('credential');
        const remote = (await pairing.get()).data()!;
        expect(remote.request).toEqual(consent);
        const grant = admin.db
          .collection('worlds')
          .doc(worldId)
          .collection('agentGrants')
          .doc(String(remote.principalUid));
        const savedGrant = (await grant.get()).data()!;
        expect(savedGrant.identityId).toBe(consent.identityId);
        expect(savedGrant.installationId).toBe(installationId);
        expect(savedGrant.blockId).toBe(remote.blockId);
        const protectedPaired = await vault('lookup');
        expect(protectedPaired.status).toBe(0);
        const pairedRecord = JSON.parse(protectedPaired.stdout);
        expect(pairedRecord.phase.state).toBe('paired');
        expect('secret' in pairedRecord.phase).toBe(false);
        expect(pairedRecord.phase.principalUid).toBe(remote.principalUid);
        expect(pairedRecord.phase.blockId).toBe(savedGrant.blockId);
        expect(pairedRecord.phase.grantExpiresAt).toBe(savedGrant.expiresAt.toMillis());
        expect(pairedRecord.approval).toEqual(consent);
        expect(pairedRecord.expiresAt).toBe(pendingRecord.expiresAt);
        const secrets: string[] = [
          proof,
          pairedRecord.phase.credential.idToken,
          pairedRecord.phase.credential.refreshToken,
        ];
        expect(secrets.every((secret) => typeof secret === 'string' && secret.length > 0)).toBe(
          true
        );

        const missingBlock = await office('inspect');
        expect(missingBlock.status, missingBlock.stdout).toBe(0);
        expect(JSON.parse(missingBlock.stdout)).toMatchObject({
          blockExists: false,
          serverAuthorizationChecked: true,
        });
        await admin.db
          .collection('worlds')
          .doc(worldId)
          .collection('blocks')
          .doc(String(remote.blockId))
          .set({ version: 1, revision: 1, objects: ['d000'], updatedAt: new Date() });
        const existingBlock = await office('inspect');
        expect(existingBlock.status, existingBlock.stdout).toBe(0);
        expect(JSON.parse(existingBlock.stdout).blockExists).toBe(true);

        // Force the local refresh threshold using the independent OS-store tool;
        // Auth remains real and refresh must preserve the exact resource lease.
        pairedRecord.phase.credential.tokenExpiresAt = 0;
        expect((await vault('store', JSON.stringify(pairedRecord))).status).toBe(0);
        const refreshed = await office('inspect');
        expect(refreshed.status, refreshed.stdout).toBe(0);
        const afterRefresh = JSON.parse((await vault('lookup')).stdout);
        expect(afterRefresh.phase.credential.tokenExpiresAt > Date.now()).toBe(true);
        expect(afterRefresh.phase.grantExpiresAt).toBe(savedGrant.expiresAt.toMillis());
        expect(afterRefresh.phase.blockId).toBe(remote.blockId);
        const expired = structuredClone(afterRefresh);
        expired.phase.grantExpiresAt = Date.now() - 1;
        expect((await vault('store', JSON.stringify(expired))).status).toBe(0);
        const expiredResult = await office('inspect');
        expect(expiredResult.status, expiredResult.stdout).toBe(0);
        const recovered = JSON.parse((await vault('lookup')).stdout);
        expect(recovered.phase.grantExpiresAt).toBe(savedGrant.expiresAt.toMillis());
        expect((await grant.get()).data()!.expiresAt.toMillis()).toBe(
          savedGrant.expiresAt.toMillis()
        );

        // Expire the actual server lease as well as its native copy. Readback
        // of a still-live server lease above is not renewal evidence.
        const pastExpiry = Date.now() - 1;
        await grant.update({
          createdAt: new Date(pastExpiry - 1000),
          expiresAt: new Date(pastExpiry),
        });
        recovered.phase.grantExpiresAt = pastExpiry;
        recovered.phase.credential.tokenExpiresAt = 0;
        expect((await vault('store', JSON.stringify(recovered))).status).toBe(0);
        const block = grant.parent.parent!.collection('blocks').doc(String(remote.blockId));
        const beforeRenewalBlock = (await block.get()).data();
        const renewed = await office('inspect');
        expect(renewed.status, renewed.stdout).toBe(0);
        expect(JSON.parse(renewed.stdout).blockExists).toBe(true);
        const renewedGrant = (await grant.get()).data()!;
        const renewedRecord = JSON.parse((await vault('lookup')).stdout);
        secrets.push(
          afterRefresh.phase.credential.idToken,
          afterRefresh.phase.credential.refreshToken,
          renewedRecord.phase.credential.idToken,
          renewedRecord.phase.credential.refreshToken
        );
        expect(renewedGrant.expiresAt.toMillis()).toBeGreaterThan(Date.now());
        expect(renewedGrant.expiresAt.toMillis() - renewedGrant.createdAt.toMillis()).toBe(
          24 * 60 * 60_000
        );
        expect(renewedRecord.phase.grantExpiresAt).toBe(renewedGrant.expiresAt.toMillis());
        expect(renewedRecord.phase.principalUid).toBe(remote.principalUid);
        expect(renewedRecord.phase.blockId).toBe(remote.blockId);
        expect(renewedGrant.capabilities).toEqual(savedGrant.capabilities);
        expect((await block.get()).data()).toEqual(beforeRenewalBlock);

        // Simulate a lost renewal response by restoring only the old local
        // record. Retry must learn the same lease, never extend it again.
        expect((await vault('store', JSON.stringify(recovered))).status).toBe(0);
        expect((await office('inspect')).status).toBe(0);
        expect((await grant.get()).data()).toEqual(renewedGrant);
        const invalidRefresh = structuredClone(renewedRecord);
        invalidRefresh.phase.credential.tokenExpiresAt = 0;
        invalidRefresh.phase.credential.refreshToken = 'invalid-refresh-token';
        expect((await vault('store', JSON.stringify(invalidRefresh))).status).toBe(0);
        const refreshDenied = await office('inspect');
        expect(refreshDenied.status).toBe(1);
        expect(JSON.parse(refreshDenied.stdout).error.code).toBe('OFFICE_REMOTE_DENIED');
        expect((await grant.get()).data()).toEqual(renewedGrant);
        const mismatched = structuredClone(afterRefresh);
        mismatched.approval.identityId = '00000000-0000-4000-8000-000000000009';
        expect((await vault('store', JSON.stringify(mismatched))).status).toBe(0);
        const invalid = await office('status');
        expect(invalid.status).toBe(1);
        expect(JSON.parse(invalid.stdout).error.code).toBe('OFFICE_CREDENTIALS_INVALID');
        expect((await vault('store', JSON.stringify(renewedRecord))).status).toBe(0);

        await grant.update({ enabled: false });
        const revokedGrant = (await grant.get()).data();
        const denied = await office('inspect');
        expect(denied.status).toBe(1);
        expect(JSON.parse(denied.stdout).error.code).toBe('OFFICE_REMOTE_DENIED');
        const offline = await office('status');
        expect(offline.status).toBe(0);
        expect(JSON.parse(offline.stdout)).toMatchObject({
          state: 'credential',
          serverAuthorizationChecked: false,
        });
        expect((await vault('store', JSON.stringify(recovered))).status).toBe(0);
        const deniedRenewal = await office('inspect');
        expect(deniedRenewal.status).toBe(1);
        expect(JSON.parse(deniedRenewal.stdout).error.code).toBe('OFFICE_REMOTE_DENIED');
        expect((await grant.get()).data()!.enabled).toBe(false);
        expect((await grant.get()).data()).toEqual(revokedGrant);
        expect(JSON.parse((await vault('lookup')).stdout).phase.grantExpiresAt).toBe(pastExpiry);
        expect((await pairing.get()).data()?.principalUid).toBe(remote.principalUid);
        expect(
          readFileSync(path.join(sandbox.globalDir, 'office', 'installation-id'), 'utf8')
        ).toBe(installationId);
        expect(
          readdirSync(path.join(sandbox.globalDir, 'office')).every(
            (name) => name === 'installation-id' || name.endsWith('.lock')
          )
        ).toBe(true);
        for (const result of [
          unpaired,
          resumed,
          missingBlock,
          existingBlock,
          renewed,
          deniedRenewal,
          denied,
          offline,
        ]) {
          expect(
            result.stdout.includes('refreshToken') ||
              result.stdout.includes('idToken') ||
              result.stdout.includes('customToken')
          ).toBe(false);
          expect(
            secrets.some(
              (secret) => result.stdout.includes(secret) || result.stderr.includes(secret)
            )
          ).toBe(false);
        }
        const databaseFiles = readdirSync(path.dirname(sandbox.database))
          .filter((name) => name.startsWith(path.basename(sandbox.database)))
          .map((name) => readFileSync(path.join(path.dirname(sandbox.database), name)));
        expect(
          secrets.some((secret) =>
            databaseFiles.some((bytes) => bytes.includes(Buffer.from(secret)))
          )
        ).toBe(false);
        const removed = await runCli(sandbox, ['rm', 'Alice', '--force', '--json']);
        expect(removed.status, removed.stdout).toBe(0);
        expect((await runCli(sandbox, ['identity', 'create', 'Alice', '--json'])).status).toBe(0);
        const replacement = await office('status');
        expect(replacement.status).toBe(0);
        expect(JSON.parse(replacement.stdout).state).toBe('unpaired');
        expect(JSON.parse(replacement.stdout).identityId).not.toBe(consent.identityId);
        const replacementRead = await office('inspect');
        expect(replacementRead.status).toBe(1);
        expect(JSON.parse(replacementRead.stdout).error.code).toBe('OFFICE_NOT_PAIRED');
      } finally {
        if (scopeKey) {
          expect((await vault('clear')).status).toBe(0);
          expect((await vault('lookup')).status).toBe(1);
        }
      }
    });
  } finally {
    await admin.dispose();
  }
});
