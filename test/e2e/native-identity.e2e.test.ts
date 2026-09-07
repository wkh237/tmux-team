import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withE2EFixture, type CliResult, type E2EFixtureOptions } from './harness.js';
import { durableState } from './identity-state-oracle.js';
import { readRealTmuxCli, releaseRealTmuxCli, spawnRealTmuxCli } from './real-tmux-caller.js';
import { installTmuxTrace } from './tmux-trace.js';
import { processTreeHasOpenFile } from './process-file-oracle.js';

interface Identity {
  id: string;
  name: string;
  canonicalName: string;
  lifetime: 'temporary' | 'saved';
}
interface Bound extends Omit<Identity, 'canonicalName'> {
  bound: true;
  pane: string;
}
interface Listed extends Identity {
  presence: 'active' | 'offline' | 'unknown';
  pane: string | null;
  command: string;
  target?: string;
  cwd?: string;
}
interface Listing {
  identities: Listed[];
}

function options(extra: E2EFixtureOptions = {}): E2EFixtureOptions {
  const native = process.env.TMT_TEST_NATIVE_CLI;
  if (!native) throw new Error('Native identity E2E requires the Docker-built CLI.');
  return { mode: 'input-log', executableEnv: { TMT_TEST_CLI: native }, ...extra };
}

function success<T>(result: CliResult<T>): T {
  expect(result.code, result.stderr || result.stdout).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.json, result.stdout).toBeDefined();
  return result.json as T;
}

describe.sequential('native identity CLI lifecycle', () => {
  it('coordinates a concurrent global observer with uncommitted publication and rechecks after lock acquisition', async () => {
    await withE2EFixture(async (fixture) => {
      fixture.enableMetadataBarrier({ phase: 'after' });
      const binder = fixture.runCliProcess<Bound>(['--json', 'name', 'Concurrent']);
      await fixture.waitForMetadataBarrier('applied');
      expect(durableState(fixture).bindings).toEqual([]);
      expect(JSON.parse(fixture.paneMetadata()).globalIdentity.name).toBe('Concurrent');
      const trace = installTmuxTrace(fixture);
      // Outside context avoids the harness's own pane-session lookup entering
      // this CLI-only trace; global observation itself needs no caller pane.
      const observer = fixture.runCliProcess<Listing>(['--json', 'ls'], { outsideTmux: true });
      let settled = false;
      void observer.result.then(() => {
        settled = true;
      });
      await fixture.waitFor(
        () =>
          !settled &&
          processTreeHasOpenFile(observer.pid, path.join(fixture.globalDir, 'tmux-team.db')),
        900,
        'native observer to open the locked database'
      );
      expect(settled).toBe(false);
      expect(trace.invocations()).toEqual([]);
      expect(durableState(fixture).bindings).toEqual([]);
      fixture.releaseMetadataBarrier();
      const bound = success(await binder.result);
      expect(success(await observer.result).identities).toEqual([
        expect.objectContaining({ id: bound.id, presence: 'active', pane: fixture.pane }),
      ]);
      expect(durableState(fixture).bindings).toEqual([
        expect.objectContaining({ identity_id: bound.id }),
      ]);
    }, options());
  });

  it('fails closed on a copied server UUID instead of confusing equal pane IDs across sockets', async () => {
    await withE2EFixture(async (first) => {
      const alice = success(await first.runJsonCli<Bound>(['name', 'Alice']));
      const metadata = first.paneMetadata();
      const serverId = JSON.parse(metadata).globalIdentity.serverId;
      await withE2EFixture(
        async (second) => {
          second.tmux(['set-option', '-s', '@tmux-team.server-id', serverId]);
          expect(second.pane).toBe(first.pane);
          const result = await second.runJsonCli<{ error: { code: string } }>(['name', 'Bob']);
          expect(result.code).toBe(1);
          expect(result.json?.error.code).toBe('RECONCILIATION_FAILED');
          expect(first.paneMetadata()).toBe(metadata);
          expect(second.paneMetadata()).toBe('');
          expect(durableState(first).bindings).toEqual([
            expect.objectContaining({ identity_id: alice.id, socket_path: first.socketPath }),
          ]);
          const list = success(await second.runJsonCli<Listing>(['ls'])).identities;
          expect(list.map((row) => [row.name, row.presence])).toEqual([
            ['Alice', 'active'],
            ['Bob', 'offline'],
          ]);
        },
        options({ globalDir: first.globalDir })
      );
    }, options());
  });

  it('preserves unknown evidence even under force and only detaches marker-mismatched temporary rows', async () => {
    await withE2EFixture(async (fixture) => {
      const initial = success(await fixture.runJsonCli<Bound>(['name', 'Uncertain']));
      const original = fixture.paneMetadata();
      const serverId = JSON.parse(original).globalIdentity.serverId;
      const before = durableState(fixture);
      fixture.tmux([
        'set-option',
        '-s',
        '@tmux-team.server-id',
        '123e4567-e89b-42d3-a456-426614174111',
      ]);
      const rows = success(await fixture.runJsonCli<Listing>(['ls'])).identities;
      expect(rows).toEqual([
        {
          id: initial.id,
          name: 'Uncertain',
          canonicalName: 'uncertain',
          lifetime: 'temporary',
          presence: 'unknown',
          pane: null,
          command: '',
        },
      ]);
      const removed = await fixture.runJsonCli<{ error: { code: string } }>([
        'rm',
        'Uncertain',
        '--force',
      ]);
      expect(removed.code).toBe(1);
      expect(removed.json?.error.code).toBe('RECONCILIATION_FAILED');
      expect(durableState(fixture)).toEqual(before);
      expect(fixture.paneMetadata()).toBe(original);
      fixture.tmux(['set-option', '-s', '@tmux-team.server-id', serverId]);
      const mismatched = JSON.parse(original);
      mismatched.globalIdentity.bindingId = 'different-binding';
      fixture.tmux([
        'set-option',
        '-p',
        '-t',
        fixture.pane,
        '@tmux-team.agent',
        JSON.stringify(mismatched),
      ]);
      const scoped = success(
        await fixture.runJsonCli<{ presence: string; pane: null }>(['ls', 'Uncertain'])
      );
      expect(scoped).toMatchObject({ presence: 'offline', pane: null });
      expect(durableState(fixture).identities).toEqual(before.identities);
      expect(durableState(fixture).bindings).toEqual([]);
      expect(JSON.parse(fixture.paneMetadata())).toEqual(mismatched);
    }, options());
  });

  it('keeps scoped reads constant and batches global discovery in a mostly unbound server', async () => {
    await withE2EFixture(async (fixture) => {
      const owner = success(await fixture.runJsonCli<Bound>(['name', 'Owner']));
      const trace = installTmuxTrace(fixture);
      success(await fixture.runJsonCli(['whoami']));
      const small = trace.invocations().length;
      for (let index = 0; index < 40; index++) {
        fixture.tmux(['new-window', '-d', '-t', 'e2e:', '-n', `idle-${index}`, 'sleep', '300']);
      }
      const peer = await fixture.createMockPane('peer');
      const second = success(await fixture.runJsonCli<Bound>(['add', peer.pane, 'Second']));
      trace.clear();
      expect(success(await fixture.runJsonCli<Bound>(['whoami']))).toEqual(owner);
      expect(trace.invocations()).toHaveLength(small);
      expect(
        trace
          .invocations()
          .filter((line) => line.includes('list-panes'))
          .every((line) => line.includes(' -f ') && line.includes(fixture.pane))
      ).toBe(true);
      trace.clear();
      const all = success(await fixture.runJsonCli<Listing>(['ls'])).identities;
      expect(all.map((row) => row.id)).toEqual([owner.id, second.id]);
      const queries = trace.invocations().filter((line) => line.includes('list-panes'));
      expect(queries).toHaveLength(1);
      expect(queries[0]).toContain(' -f ');
      expect(queries[0]).toContain(fixture.pane);
      expect(queries[0]).toContain(peer.pane);
      expect(durableState(fixture).identities).toHaveLength(2);
    }, options());
  });

  it('uses global names, promotes the same UUID, and keeps saved identities offline', async () => {
    await withE2EFixture(async (fixture) => {
      const initial = success(await fixture.runJsonCli<Bound>(['name', 'Alice']));
      expect(initial).toEqual({
        bound: true,
        id: expect.any(String),
        name: 'Alice',
        pane: fixture.pane,
        lifetime: 'temporary',
      });
      expect(JSON.parse(fixture.paneMetadata()).globalIdentity.identityId).toBe(initial.id);
      const otherFolder = fixture.createWorkspace('other-folder');
      const saved = success(
        await fixture.runJsonCli<Bound>(['this', 'ALICE', '-s'], { cwd: otherFolder })
      );
      expect(saved).toEqual({ ...initial, lifetime: 'saved' });
      expect(success(await fixture.runJsonCli<Bound>(['name', 'alice']))).toEqual(saved);
      expect(success(await fixture.runJsonCli<Bound>(['whoami']))).toEqual(saved);
      const live = success(
        await fixture.runJsonCli<Listing>(['ls'], { cwd: otherFolder })
      ).identities;
      expect(live).toEqual([
        {
          id: initial.id,
          name: 'Alice',
          canonicalName: 'alice',
          lifetime: 'saved',
          presence: 'active',
          pane: fixture.pane,
          command: expect.any(String),
          target: fixture.paneTarget(fixture.pane),
          cwd: fixture.workspace,
        },
      ]);

      expect(success(await fixture.runJsonCli(['unbind']))).toEqual({
        unbound: true,
        id: initial.id,
        name: 'Alice',
        pane: fixture.pane,
        lifetime: 'saved',
        retired: false,
      });
      expect(fixture.paneMetadata()).toBe('');
      expect(
        success(await fixture.runJsonCli<Listing>(['ls'], { withoutTmux: true })).identities
      ).toEqual([
        {
          id: initial.id,
          name: 'Alice',
          canonicalName: 'alice',
          lifetime: 'saved',
          presence: 'offline',
          pane: null,
          command: '',
        },
      ]);
      const denied = await fixture.runJsonCli<{ error: { code: string } }>(['rm', 'Alice'], {
        withoutTmux: true,
      });
      expect(denied.code).toBe(5);
      expect(denied.json?.error.code).toBe('CONFIRMATION_REQUIRED');
      expect(
        success(await fixture.runJsonCli(['remove', 'Alice', '--force'], { withoutTmux: true }))
      ).toEqual({
        removed: true,
        identity: { id: initial.id, name: 'Alice', canonicalName: 'alice', lifetime: 'saved' },
      });
      expect(
        success(await fixture.runJsonCli<Listing>(['ls'], { withoutTmux: true })).identities
      ).toEqual([]);
      expect(durableState(fixture).identities).toEqual([
        expect.objectContaining({ id: initial.id, retired_at_ms: expect.any(Number) }),
      ]);
      expect(fs.existsSync(fixture.forbiddenTmuxLogPath)).toBe(false);
    }, options());
  });

  it('resolves pane selectors, preserves movement, retires dead temporary names, and never kills on rm', async () => {
    await withE2EFixture(async (fixture) => {
      const peer = await fixture.createMockPane('peer');
      const named = success(
        await fixture.runJsonCli<Bound>(['add', fixture.paneTarget(peer.pane), 'Worker'])
      );
      fixture.tmux([
        'move-window',
        '-s',
        fixture.paneTarget(peer.pane).split('.')[0]!,
        '-t',
        'e2e:8',
      ]);
      const moved = success(await fixture.runJsonCli<Listing>(['ls'])).identities[0];
      expect(moved).toMatchObject({
        id: named.id,
        pane: peer.pane,
        target: fixture.paneTarget(peer.pane),
        lifetime: 'temporary',
        presence: 'active',
      });
      fixture.tmux(['kill-pane', '-t', peer.pane]);
      expect(success(await fixture.runJsonCli<Listing>(['ls'])).identities).toEqual([]);
      const fresh = success(await fixture.runJsonCli<Bound>(['add', fixture.pane, 'worker']));
      expect(fresh.id).not.toBe(named.id);
      const removed = success(await fixture.runJsonCli<{ removed: boolean }>(['rm', 'worker']));
      expect(removed.removed).toBe(true);
      expect(fixture.mockProcessIsRunning()).toBe(true);
      expect(fixture.paneMetadata()).toBe('');
      expect(success(await fixture.runJsonCli(['whoami']))).toEqual({
        bound: false,
        pane: fixture.pane,
      });
      expect(durableState(fixture).identities).toHaveLength(2);
      expect(
        durableState(fixture).identities.every((row) => typeof row.retired_at_ms === 'number')
      ).toBe(true);
    }, options());
  });

  it('retains separately committed creation on an occupied pane and permits an explicit retry', async () => {
    await withE2EFixture(async (fixture) => {
      const owner = success(await fixture.runJsonCli<Bound>(['name', 'Owner']));
      const failed = await fixture.runJsonCli<{ error: { code: string } }>(['name', 'Retry']);
      expect(failed.code).toBe(5);
      expect(failed.json?.error.code).toBe('PANE_ALREADY_BOUND');
      const state = durableState(fixture);
      const retry = state.identities.find((row) => row.canonical_name === 'retry')!;
      expect(retry).toMatchObject({
        id: expect.any(String),
        lifetime: 'temporary',
        retired_at_ms: null,
      });
      expect(state.bindings).toEqual([expect.objectContaining({ identity_id: owner.id })]);
      const listing = success(await fixture.runJsonCli<Listing>(['ls']));
      expect(listing.identities[1]).toMatchObject({
        id: retry.id,
        presence: 'offline',
        pane: null,
        command: '',
      });
      const peer = await fixture.createMockPane('retry');
      expect(success(await fixture.runJsonCli<Bound>(['add', peer.pane, 'retry'])).id).toBe(
        retry.id
      );
    }, options());
  });

  it.each([
    { name: 'complete', stripTmux: false, stripPane: false },
    { name: 'no-pane', stripTmux: false, stripPane: true },
    { name: 'no-tmux', stripTmux: true, stripPane: false },
    { name: 'neither', stripTmux: true, stripPane: true },
  ])(
    'binds a real descendant with $name context without guessing the selected pane',
    async (context) => {
      await withE2EFixture(async (fixture) => {
        const real = await spawnRealTmuxCli(fixture, ['name', 'Descendant'], context);
        fixture.tmux(['select-pane', '-t', fixture.pane]);
        await releaseRealTmuxCli(fixture, real);
        const result = readRealTmuxCli<Bound>(real);
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toMatchObject({
          bound: true,
          name: 'Descendant',
          pane: real.pane,
          lifetime: 'temporary',
        });
        expect(JSON.parse(fixture.paneMetadata(real.pane)).globalIdentity.identityId).toBe(
          result.stdout.id
        );
        expect(fixture.paneMetadata()).toBe('');
        expect(
          success(await fixture.runJsonCli<Listing>(['ls'])).identities.map((row) => row.pane)
        ).toEqual([real.pane]);
      }, options());
    },
    20_000
  );

  it.each(['grouped', 'linked'] as const)(
    'keeps one identity and the attached presentation for %s windows',
    async (mode) => {
      await withE2EFixture(async (fixture) => {
        const identity = success(await fixture.runJsonCli<Bound>(['name', 'Grouped']));
        if (mode === 'grouped') fixture.tmux(['new-session', '-d', '-t', 'e2e', '-s', 'attached']);
        else {
          fixture.tmux(['new-session', '-d', '-s', 'attached', 'sleep', '300']);
          fixture.tmux(['link-window', '-s', 'e2e:0', '-t', 'attached:']);
        }
        await fixture.attachSessionClient('attached');
        const live = success(await fixture.runJsonCli<Listing>(['ls'])).identities;
        expect(live).toHaveLength(1);
        expect(live[0]).toMatchObject({
          id: identity.id,
          pane: fixture.pane,
          presence: 'active',
          target: expect.stringMatching(/^attached:/),
        });
        const scoped = success(
          await fixture.runJsonCli<{ pane: { id: string; target: string } }>(['ls', fixture.pane])
        );
        expect(scoped.pane).toMatchObject({ id: fixture.pane, target: live[0]!.target });
        expect(durableState(fixture).bindings).toHaveLength(1);
      }, options());
    }
  );

  it('rolls back a failed post-publication verification and recovers an orphan marker on retry', async () => {
    await withE2EFixture(async (fixture) => {
      fixture.enableMetadataBarrier({ phase: 'after' });
      const process = fixture.runCliProcess(['--json', 'name', 'Retry']);
      await fixture.waitForMetadataBarrier('applied');
      const orphan = JSON.parse(fixture.paneMetadata()).globalIdentity;
      const pending = durableState(fixture);
      expect(pending.bindings).toEqual([]);
      expect(pending.identities).toEqual([
        expect.objectContaining({ id: orphan.identityId, retired_at_ms: null }),
      ]);
      // Kill only this fixture-owned CLI group while its published metadata is
      // visible but the transaction is uncommitted.
      process.kill('SIGKILL');
      expect((await process.result).code).not.toBe(0);
      fixture.releaseMetadataBarrier();
      expect(durableState(fixture).bindings).toEqual([]);
      const offline = success(await fixture.runJsonCli<Listing>(['ls'])).identities;
      expect(offline).toEqual([
        expect.objectContaining({ id: orphan.identityId, presence: 'offline', pane: null }),
      ]);
      expect(JSON.parse(fixture.paneMetadata()).globalIdentity).toEqual(orphan);
      const retry = success(await fixture.runJsonCli<Bound>(['name', 'Retry']));
      expect(retry.id).toBe(orphan.identityId);
      const marker = JSON.parse(fixture.paneMetadata()).globalIdentity;
      expect(marker.bindingId).not.toBe(orphan.bindingId);
      expect(durableState(fixture).bindings).toEqual([
        expect.objectContaining({ id: marker.bindingId, identity_id: retry.id }),
      ]);
    }, options());
  });

  it('does not publish success when the pane disappears during publication', async () => {
    await withE2EFixture(async (fixture) => {
      const peer = await fixture.createMockPane('vanishing');
      fixture.enableMetadataBarrier({ phase: 'before' });
      const process = fixture.runCliProcess(['--json', 'add', peer.pane, 'Vanished']);
      await fixture.waitForMetadataBarrier();
      fixture.tmux(['kill-pane', '-t', peer.pane]);
      fixture.releaseMetadataBarrier();
      const result = await process.result;
      expect(result.code).toBe(1);
      expect(result.json).toMatchObject({ error: { code: 'RECONCILIATION_FAILED' } });
      expect(result.stdout).not.toContain('"bound":true');
      expect(durableState(fixture).bindings).toEqual([]);
      expect(durableState(fixture).identities).toEqual([
        expect.objectContaining({ canonical_name: 'vanished', retired_at_ms: null }),
      ]);
      expect(fixture.paneMetadata()).toBe('');
    }, options());
  });

  it('leaves user border formats untouched and only opts into the pane-local badge value', async () => {
    await withE2EFixture(async (fixture) => {
      const theme = '#{pane_index}---#{pane_current_path}';
      fixture.tmux(['set-option', '-w', '-t', fixture.pane, 'pane-border-format', theme]);
      success(await fixture.runJsonCli(['name', 'Alice']));
      const badge = () =>
        fixture.tmux(['show-options', '-p', '-qv', '-t', fixture.pane, '@tmux-team.badge']).trim();
      expect(badge()).toBe('');
      success(await fixture.runJsonCli(['config', 'set', 'ui.paneBadge', 'on', '--global']));
      success(await fixture.runJsonCli(['name', 'Alice']));
      expect(badge()).toBe('Alice (tmt)');
      expect(
        fixture.tmux(['show-options', '-w', '-v', '-t', fixture.pane, 'pane-border-format']).trim()
      ).toBe(theme);
      success(await fixture.runJsonCli(['unbind']));
      expect(badge()).toBe('');
      expect(
        fixture.tmux(['show-options', '-w', '-v', '-t', fixture.pane, 'pane-border-format']).trim()
      ).toBe(theme);
    }, options());
  });

  it('routes foreign removal by its recorded socket without touching an equal local pane ID', async () => {
    await withE2EFixture(async (first) => {
      const alice = success(await first.runJsonCli<Bound>(['name', 'Alice', '-s']));
      await withE2EFixture(
        async (second) => {
          const bob = success(await second.runJsonCli<Bound>(['name', 'Bob']));
          expect(second.pane).toBe(first.pane);
          expect(
            success(await second.runJsonCli<Listing>(['ls'])).identities.map((row) => [
              row.id,
              row.presence,
            ])
          ).toEqual([
            [alice.id, 'active'],
            [bob.id, 'active'],
          ]);
          success(await second.runJsonCli(['rm', 'Alice', '--force']));
          expect(first.paneMetadata()).toBe('');
          expect(JSON.parse(second.paneMetadata()).globalIdentity.identityId).toBe(bob.id);
          expect(first.mockProcessIsRunning()).toBe(true);
          expect(second.mockProcessIsRunning()).toBe(true);
        },
        options({ globalDir: first.globalDir })
      );
      // Native global visibility reconciles conclusive foreign death too;
      // the installed TS current-server-only rule is not this contract.
      expect(success(await first.runJsonCli<Listing>(['ls'])).identities).toEqual([]);
      expect(
        durableState(first).identities.every((row) => typeof row.retired_at_ms === 'number')
      ).toBe(true);
    }, options());
  });
});
