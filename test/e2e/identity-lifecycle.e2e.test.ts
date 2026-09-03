import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { E2EFixture, withE2EFixture, type CliResult, type MockPane } from './harness.js';

interface Identity {
  name: string;
  canonicalName: string;
}

interface IdentityListItem extends Identity {
  pane: string;
  target: string;
  cwd: string;
  command: string;
}

interface CommandError {
  error: { code: string; message: string; suggestion?: string };
}

function json<T>(result: CliResult<T>): T {
  expect(result.stdout.trim()).not.toBe('');
  expect(() => JSON.parse(result.stdout)).not.toThrow();
  expect(result.stderr).toBe('');
  expect(result.json).toBeDefined();
  return result.json as T;
}

async function listIdentities(fixture: E2EFixture): Promise<IdentityListItem[]> {
  const result = await fixture.runJsonCli<{ identities: IdentityListItem[] }>(['list']);
  expect(result.code).toBe(0);
  return json(result).identities;
}

function metadata(fixture: E2EFixture, pane: MockPane): Record<string, unknown> {
  return JSON.parse(fixture.paneMetadata(pane.pane)) as Record<string, unknown>;
}

function eventCount(
  fixture: E2EFixture,
  event: 'request' | 'response',
  pid: number,
  message: string
): number {
  return fixture
    .events()
    .filter((entry) => entry.event === event && entry.pid === pid && entry.message === message)
    .length;
}

async function talkToIdentity(
  fixture: E2EFixture,
  name: string,
  pid: number,
  otherPids: number[],
  message: string
): Promise<void> {
  const before = fixture.events();
  const result = await fixture.runJsonCli<{
    target: string;
    pane: string;
    identity: Identity;
    status: string;
    response: string;
  }>(['talk', name, message, '--wait', '--timeout', '10']);
  expect(result.code).toBe(0);
  const output = json(result);
  expect(output).toMatchObject({ target: name, identity: { name }, status: 'completed' });
  expect(output.response).toContain(`mock-agent response: ${message}`);
  await fixture.waitForEvent(
    (entry) => entry.event === 'response' && entry.pid === pid && entry.message === message
  );

  const after = fixture.events();
  const beforeRequest = before.filter(
    (entry) => entry.event === 'request' && entry.pid === pid && entry.message === message
  ).length;
  const beforeResponse = before.filter(
    (entry) => entry.event === 'response' && entry.pid === pid && entry.message === message
  ).length;
  expect(eventCount(fixture, 'request', pid, message) - beforeRequest).toBe(1);
  expect(eventCount(fixture, 'response', pid, message) - beforeResponse).toBe(1);
  for (const otherPid of otherPids) {
    expect(
      after.filter(
        (entry) =>
          (entry.event === 'request' || entry.event === 'response') &&
          entry.pid === otherPid &&
          entry.message === message
      )
    ).toHaveLength(0);
  }
}

describe.sequential('global identity lifecycle', () => {
  it('runs the real name/this/whoami/unbind lifecycle with human and JSON contracts', async () => {
    await withE2EFixture(async (fixture) => {
      const pane = fixture.pane;
      const peer = await fixture.createMockPane('peer');
      const peerBinding = await fixture.runJsonCli(['add', peer.pane, 'Peer']);
      expect(peerBinding.code).toBe(0);
      const peerMetadata = fixture.paneMetadata(peer.pane);
      const peerList = await listIdentities(fixture);

      const initial = await fixture.runJsonCli<{ bound: false; pane: string }>(['whoami']);
      expect(initial.code).toBe(0);
      expect(json(initial)).toEqual({ bound: false, pane });

      const initialHuman = await fixture.runCli(['whoami']);
      expect(initialHuman.code).toBe(0);
      expect(initialHuman.stdout).toContain(`Pane ${pane} is unbound.`);
      expect(initialHuman.stderr).toBe('');

      const namedJson = await fixture.runJsonCli<{ bound: true; name: string; pane: string }>([
        'name',
        'Lifecycle',
      ]);
      expect(namedJson.code).toBe(0);
      expect(json(namedJson)).toEqual({ bound: true, name: 'Lifecycle', pane });

      const namedHuman = await fixture.runCli(['name', 'Lifecycle']);
      expect(namedHuman.code).toBe(0);
      expect(namedHuman.stdout).toContain(`Bound 'Lifecycle' to pane ${pane}`);
      expect(namedHuman.stderr).toBe('');

      const whoamiHuman = await fixture.runCli(['whoami']);
      expect(whoamiHuman.code).toBe(0);
      expect(whoamiHuman.stdout).toContain(`Bound identity 'Lifecycle' on pane ${pane}`);
      expect(whoamiHuman.stderr).toBe('');

      const whoamiJson = await fixture.runJsonCli<{ bound: true; name: string; pane: string }>([
        'whoami',
      ]);
      expect(whoamiJson.code).toBe(0);
      expect(json(whoamiJson)).toEqual({ bound: true, name: 'Lifecycle', pane });

      const unboundJson = await fixture.runJsonCli<{ unbound: true; name: string; pane: string }>([
        'unbind',
      ]);
      expect(unboundJson.code).toBe(0);
      expect(json(unboundJson)).toEqual({ unbound: true, name: 'Lifecycle', pane });

      const rebound = await fixture.runJsonCli<{ bound: true; name: string; pane: string }>([
        'this',
        'Lifecycle',
      ]);
      expect(rebound.code).toBe(0);
      expect(json(rebound)).toEqual(json(namedJson));
      expect(rebound.stderr).toBe('');

      const reboundHuman = await fixture.runCli(['this', 'Lifecycle']);
      expect(reboundHuman.code).toBe(0);
      expect(reboundHuman.stdout).toContain(`Bound 'Lifecycle' to pane ${pane}`);
      expect(reboundHuman.stderr).toBe('');

      const beforeConflictList = await listIdentities(fixture);
      const beforeConflictMetadata = fixture.paneMetadata(pane);
      const nameConflict = await fixture.runJsonCli<CommandError>(['name', 'Conflict']);
      const thisConflict = await fixture.runJsonCli<CommandError>(['this', 'Conflict']);
      expect(nameConflict.code).toBe(5);
      expect(thisConflict.code).toBe(nameConflict.code);
      expect(json(nameConflict)).toEqual({
        error: { code: 'PANE_ALREADY_BOUND', message: 'Pane is already bound to another name.' },
      });
      expect(json(thisConflict)).toEqual(json(nameConflict));
      expect(fixture.paneMetadata(pane)).toBe(beforeConflictMetadata);
      expect(await listIdentities(fixture)).toEqual(beforeConflictList);

      const unboundHuman = await fixture.runCli(['unbind']);
      expect(unboundHuman.code).toBe(0);
      expect(unboundHuman.stdout).toContain(`Unbound pane ${pane}`);
      expect(unboundHuman.stderr).toBe('');

      const repeated = await fixture.runJsonCli<CommandError>(['unbind']);
      expect(repeated.code).toBe(1);
      expect(json(repeated)).toEqual({
        error: { code: 'UNBOUND_PANE', message: 'Pane has no active global name.' },
      });
      expect(fixture.paneMetadata(peer.pane)).toBe(peerMetadata);
      expect(await listIdentities(fixture)).toEqual(peerList);

      const finalWhoami = await fixture.runJsonCli<{ bound: false; pane: string }>(['whoami']);
      expect(finalWhoami.code).toBe(0);
      expect(json(finalWhoami)).toEqual({ bound: false, pane });
    });
  }, 30_000);

  it('accepts every pane target form, normalizes names, is idempotent, and preserves failed state', async () => {
    await withE2EFixture(async (fixture) => {
      const alpha = await fixture.createMockPane('alpha');
      const beta = await fixture.createMockPane('beta');
      const gamma = await fixture.createMockPane('gamma');
      const betaTarget = fixture.paneTarget(beta.pane);
      const gammaTarget = fixture.paneTarget(gamma.pane);

      const alphaAdd = await fixture.runJsonCli<{ bound: true; name: string; pane: string }>([
        'add',
        alpha.pane,
        '  Alpha  ',
      ]);
      expect(alphaAdd.code).toBe(0);
      expect(json(alphaAdd)).toEqual({ bound: true, name: 'Alpha', pane: alpha.pane });

      const betaAdd = await fixture.runJsonCli<{ bound: true; name: string; pane: string }>([
        'add',
        betaTarget.slice(betaTarget.indexOf(':') + 1),
        'Beta',
      ]);
      expect(betaAdd.code).toBe(0);
      expect(json(betaAdd)).toEqual({ bound: true, name: 'Beta', pane: beta.pane });

      const gammaAdd = await fixture.runJsonCli<{ bound: true; name: string; pane: string }>([
        'add',
        gammaTarget,
        'Gamma',
      ]);
      expect(gammaAdd.code).toBe(0);
      expect(json(gammaAdd)).toEqual({ bound: true, name: 'Gamma', pane: gamma.pane });

      expect(metadata(fixture, alpha)).toMatchObject({
        version: 1,
        globalIdentity: { name: 'Alpha', canonicalName: 'alpha' },
      });
      expect(metadata(fixture, beta)).toMatchObject({
        version: 1,
        globalIdentity: { name: 'Beta', canonicalName: 'beta' },
      });
      expect(metadata(fixture, gamma)).toMatchObject({
        version: 1,
        globalIdentity: { name: 'Gamma', canonicalName: 'gamma' },
      });

      const beforeIdempotent = await listIdentities(fixture);
      const beforeMetadata = fixture.paneMetadata(alpha.pane);
      const idempotent = await fixture.runJsonCli(['add', alpha.pane, ' ＡＬＰＨＡ ']);
      expect(idempotent.code).toBe(0);
      expect(json(idempotent)).toEqual({ bound: true, name: 'Alpha', pane: alpha.pane });
      expect(fixture.paneMetadata(alpha.pane)).toBe(beforeMetadata);
      expect(await listIdentities(fixture)).toEqual(beforeIdempotent);

      const beforeConflictList = await listIdentities(fixture);
      const beforeConflictMetadata = [
        fixture.paneMetadata(alpha.pane),
        fixture.paneMetadata(beta.pane),
        fixture.paneMetadata(gamma.pane),
        fixture.paneMetadata(fixture.pane),
      ];
      const paneConflict = await fixture.runJsonCli<CommandError>(['add', alpha.pane, 'Other']);
      expect(paneConflict.code).toBe(5);
      expect(json(paneConflict)).toEqual({
        error: { code: 'PANE_ALREADY_BOUND', message: 'Pane is already bound to another name.' },
      });
      const nameConflict = await fixture.runJsonCli<CommandError>([
        'add',
        fixture.pane,
        ' ＡＬＰＨＡ ',
      ]);
      expect(nameConflict.code).toBe(5);
      expect(json(nameConflict)).toEqual({
        error: { code: 'NAME_ALREADY_ACTIVE', message: 'Name is already active on another pane.' },
      });
      expect(await listIdentities(fixture)).toEqual(beforeConflictList);
      expect([
        fixture.paneMetadata(alpha.pane),
        fixture.paneMetadata(beta.pane),
        fixture.paneMetadata(gamma.pane),
        fixture.paneMetadata(fixture.pane),
      ]).toEqual(beforeConflictMetadata);
    });
  }, 30_000);

  it('rejects empty, control-character, and pane-shaped names without side effects', async () => {
    await withE2EFixture(async (fixture) => {
      const beforeList = await listIdentities(fixture);
      const beforeMetadata = fixture.paneMetadata(fixture.pane);
      const cases = [
        ['', 'Identity name must not be empty or contain control characters.'],
        ['   ', 'Identity name must not be empty or contain control characters.'],
        ['bad\u0001name', 'Identity name must not be empty or contain control characters.'],
        ['%99999', 'Identity name must not look like a pane target.'],
        ['0.0', 'Identity name must not look like a pane target.'],
        ['e2e:0.0', 'Identity name must not look like a pane target.'],
      ] as const;
      for (const [invalidName, message] of cases) {
        const result = await fixture.runJsonCli<CommandError>(['add', fixture.pane, invalidName]);
        expect(result.code).toBe(1);
        expect(json(result)).toEqual({
          error: { code: 'INVALID_NAME', message },
        });
        expect(await listIdentities(fixture)).toEqual(beforeList);
        expect(fixture.paneMetadata(fixture.pane)).toBe(beforeMetadata);
      }
    });
  }, 30_000);

  it('retains bound IDs and routes to the right PID across join, break, and swap', async () => {
    await withE2EFixture(async (fixture) => {
      const alpha = await fixture.createMockPane('alpha');
      const beta = await fixture.createMockPane('beta');
      await fixture.runJsonCli(['add', alpha.pane, 'Alpha']);
      await fixture.runJsonCli(['add', beta.pane, 'Beta']);
      const alphaMetadata = fixture.paneMetadata(alpha.pane);
      const betaMetadata = fixture.paneMetadata(beta.pane);
      const alphaInitialTarget = fixture.paneTarget(alpha.pane);
      const betaInitialTarget = fixture.paneTarget(beta.pane);

      fixture.tmux(['join-pane', '-s', alpha.pane, '-t', beta.pane]);
      const alphaJoinedTarget = fixture.paneTarget(alpha.pane);
      expect(alphaJoinedTarget).not.toBe(alphaInitialTarget);
      expect(fixture.paneMetadata(alpha.pane)).toBe(alphaMetadata);
      expect(fixture.paneMetadata(beta.pane)).toBe(betaMetadata);
      expect((await listIdentities(fixture)).find((item) => item.pane === alpha.pane)?.target).toBe(
        alphaJoinedTarget
      );
      await talkToIdentity(fixture, 'Alpha', alpha.pid, [beta.pid], 'after-join-alpha');

      fixture.tmux(['break-pane', '-s', alpha.pane, '-d']);
      const alphaBrokenTarget = fixture.paneTarget(alpha.pane);
      expect(alphaBrokenTarget).not.toBe(alphaJoinedTarget);
      expect(fixture.paneMetadata(alpha.pane)).toBe(alphaMetadata);
      expect(fixture.paneMetadata(beta.pane)).toBe(betaMetadata);
      await talkToIdentity(fixture, 'Alpha', alpha.pid, [beta.pid], 'after-break-alpha');

      const alphaBeforeSwap = fixture.paneTarget(alpha.pane);
      const betaBeforeSwap = fixture.paneTarget(beta.pane);
      fixture.tmux(['swap-pane', '-s', alpha.pane, '-t', beta.pane]);
      expect(fixture.paneTarget(alpha.pane)).toBe(betaBeforeSwap);
      expect(fixture.paneTarget(beta.pane)).toBe(alphaBeforeSwap);
      expect(fixture.paneMetadata(alpha.pane)).toBe(alphaMetadata);
      expect(fixture.paneMetadata(beta.pane)).toBe(betaMetadata);
      await talkToIdentity(fixture, 'Alpha', alpha.pid, [beta.pid], 'after-swap-alpha');
      await talkToIdentity(fixture, 'Beta', beta.pid, [alpha.pid], 'after-swap-beta');

      expect(fixture.paneTarget(alpha.pane)).not.toBe(alphaInitialTarget);
      expect(fixture.paneTarget(beta.pane)).not.toBe(betaInitialTarget);
    });
  }, 45_000);

  it('distinguishes name and pane disappearance after kill-pane while preserving peers', async () => {
    await withE2EFixture(async (fixture) => {
      const gone = await fixture.createMockPane('gone');
      const peer = await fixture.createMockPane('peer');
      await fixture.runJsonCli(['add', gone.pane, 'Gone']);
      await fixture.runJsonCli(['add', peer.pane, 'Peer']);
      const peerMetadata = fixture.paneMetadata(peer.pane);

      fixture.tmux(['kill-pane', '-t', gone.pane]);
      await fixture.waitFor(
        () => {
          try {
            return !fixture
              .tmux(['list-panes', '-a', '-F', '#{pane_id}'])
              .split('\n')
              .includes(gone.pane);
          } catch {
            return true;
          }
        },
        2_000,
        'killed pane to disappear'
      );

      expect(await listIdentities(fixture)).toEqual([
        {
          name: 'Peer',
          canonicalName: 'peer',
          pane: peer.pane,
          target: fixture.paneTarget(peer.pane),
          cwd: peer.workspace,
          command: 'node',
        },
      ]);
      expect(fixture.paneMetadata(peer.pane)).toBe(peerMetadata);

      const nameNotFound = await fixture.runJsonCli<CommandError>([
        'talk',
        'Gone',
        'must-not-send',
      ]);
      expect(nameNotFound.code).toBe(3);
      expect(json(nameNotFound)).toEqual({
        error: { code: 'NAME_NOT_FOUND', message: "Identity 'Gone' is not active." },
      });

      const paneNotFound = await fixture.runJsonCli<CommandError>(['check', gone.pane]);
      expect(paneNotFound.code).toBe(3);
      expect(json(paneNotFound)).toEqual({
        error: { code: 'PANE_NOT_FOUND', message: `Pane target '${gone.pane}' was not found.` },
      });
      await talkToIdentity(fixture, 'Peer', peer.pid, [], 'peer-still-routes');
    });
  }, 30_000);

  it('does not resurrect identities after a real tmux-server restart', async () => {
    await withE2EFixture(async (fixture) => {
      const oldPane = fixture.pane;
      const oldPid = fixture.panePid;
      const secondary = await fixture.createMockPane('secondary');
      const bound = await fixture.runJsonCli(['add', oldPane, 'BeforeRestart']);
      expect(bound.code).toBe(0);
      const secondaryBound = await fixture.runJsonCli([
        'add',
        secondary.pane,
        'SecondaryBeforeRestart',
      ]);
      expect(secondaryBound.code).toBe(0);
      expect((await listIdentities(fixture)).map(({ name }) => name)).toEqual([
        'BeforeRestart',
        'SecondaryBeforeRestart',
      ]);

      const restarted = await fixture.restartServer();
      expect(restarted.pid).not.toBe(oldPid);
      expect(restarted.pane).not.toBe(secondary.pane);
      expect(fixture.serverIsRunning()).toBe(true);
      expect(await listIdentities(fixture)).toEqual([]);

      const whoami = await fixture.runJsonCli<{ bound: false; pane: string }>(['whoami']);
      expect(whoami.code).toBe(0);
      expect(json(whoami)).toEqual({ bound: false, pane: restarted.pane });

      const stalePane = await fixture.runJsonCli<CommandError>(['check', secondary.pane]);
      expect(stalePane.code).toBe(3);
      expect(json(stalePane)).toEqual({
        error: {
          code: 'PANE_NOT_FOUND',
          message: `Pane target '${secondary.pane}' was not found.`,
        },
      });
      const staleName = await fixture.runJsonCli<CommandError>([
        'talk',
        'BeforeRestart',
        'must-not-send',
      ]);
      expect(staleName.code).toBe(3);
      expect(json(staleName)).toEqual({
        error: { code: 'NAME_NOT_FOUND', message: "Identity 'BeforeRestart' is not active." },
      });

      const rebound = await fixture.runJsonCli(['add', restarted.pane, 'AfterRestart']);
      expect(rebound.code).toBe(0);
      expect(await listIdentities(fixture)).toEqual([
        {
          name: 'AfterRestart',
          canonicalName: 'afterrestart',
          pane: restarted.pane,
          target: fixture.paneTarget(restarted.pane),
          cwd: restarted.workspace,
          command: 'node',
        },
      ]);
    });
  }, 30_000);

  it('preserves a durable identity across pane death and a later rebind', async () => {
    await withE2EFixture(async (fixture) => {
      const gone = await fixture.createMockPane('durable');
      const original = await fixture.runJsonCli(['add', gone.pane, 'Durable']);
      expect(original.code).toBe(0);
      const database = new Database(path.join(fixture.globalDir, 'tmux-team.db'), {
        readonly: true,
      });
      const identity = database
        .prepare('SELECT id FROM identities WHERE canonical_name = ?')
        .get('durable') as { id: string };
      database.close();
      expect(identity.id).toMatch(/^[0-9a-f-]{36}$/);

      fixture.tmux(['kill-pane', '-t', gone.pane]);
      await fixture.waitFor(
        () => {
          try {
            return !fixture.tmux(['list-panes', '-a', '-F', '#{pane_id}']).includes(gone.pane);
          } catch {
            return true;
          }
        },
        2_000,
        'durable pane to disappear'
      );
      expect((await fixture.runJsonCli(['list'])).json).toEqual({ identities: [] });

      const afterDeath = new Database(path.join(fixture.globalDir, 'tmux-team.db'), {
        readonly: true,
      });
      expect(
        afterDeath.prepare('SELECT id FROM identities WHERE canonical_name = ?').get('durable')
      ).toEqual(identity);
      expect(afterDeath.prepare('SELECT COUNT(*) AS count FROM bindings').get()).toEqual({
        count: 0,
      });
      afterDeath.close();

      const replacement = await fixture.createMockPane('replacement');
      const rebound = await fixture.runJsonCli(['add', replacement.pane, 'durable']);
      expect(rebound.code).toBe(0);
      const afterRebind = new Database(path.join(fixture.globalDir, 'tmux-team.db'), {
        readonly: true,
      });
      expect(
        afterRebind.prepare('SELECT id FROM identities WHERE canonical_name = ?').get('durable')
      ).toEqual(identity);
      afterRebind.close();
    });
  }, 30_000);
});
