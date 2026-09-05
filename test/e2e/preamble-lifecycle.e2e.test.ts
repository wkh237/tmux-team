import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { withE2EFixture, type CliResult, type E2EFixture, type MockEvent } from './harness.js';

interface CommandError {
  error: { code: string; message: string };
}

interface PreambleValue {
  agent: string;
  preamble: string | null;
  status?: 'set' | 'cleared' | 'not_set';
}

interface RoleValue {
  identity: { id: string; name: string; canonicalName: string };
  role: { content: string; updatedAt: string } | null;
}

interface TalkResult {
  status: string;
  response: string;
  nonce: string;
}

function json<T>(result: CliResult<T>): T {
  expect(result.code, result.stderr || result.stdout).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.json).toBeDefined();
  return result.json as T;
}

function expectError(result: CliResult<CommandError>, code: string, exitCode: number): void {
  expect(result.code).toBe(exitCode);
  expect(result.stderr).toBe('');
  expect(result.json).toMatchObject({ error: { code } });
}

function identityId(fixture: E2EFixture, name: string): string {
  // This read-only oracle makes rebind preservation independent of display-name casing.
  const database = new Database(path.join(fixture.globalDir, 'tmux-team.db'), { readonly: true });
  try {
    const row = database
      .prepare('SELECT id FROM identities WHERE canonical_name = ?')
      .get(name.toLowerCase()) as { id: string } | undefined;
    expect(row).toBeDefined();
    return row!.id;
  } finally {
    database.close();
  }
}

function preambleCounters(fixture: E2EFixture): Record<string, number> {
  const statePath = path.join(fixture.globalDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
    preambleCounters?: Record<string, number>;
  };
  return state.preambleCounters ?? {};
}

async function causalTalk(
  fixture: E2EFixture,
  target: string,
  pid: number,
  message: string,
  expectedPreamble?: string,
  extraArgs: string[] = []
): Promise<MockEvent> {
  const result = await fixture.runJsonCli<TalkResult>([
    'talk',
    target,
    message,
    '--wait',
    '--timeout',
    '8',
    ...extraArgs,
  ]);
  const output = json<TalkResult>(result);
  expect(output.status).toBe('completed');
  expect(output.response).toContain(message);
  expect(output.nonce).toMatch(/^[a-z0-9]+$/);
  // readline in the fixture intentionally records the logical payload without
  // the empty separator line; the production transport still sends \n\n.
  const expectedMessage = expectedPreamble ? `[SYSTEM: ${expectedPreamble}]\n${message}` : message;
  const event = await fixture.waitForEvent(
    (entry) =>
      entry.event === 'response' &&
      entry.pid === pid &&
      entry.nonce === output.nonce &&
      entry.message === expectedMessage
  );
  expect(event.nonce).toBe(output.nonce);
  expect(
    fixture
      .events()
      .some(
        (entry) =>
          entry.event === 'request' &&
          entry.pid === pid &&
          entry.nonce === event.nonce &&
          entry.message === expectedMessage
      )
  ).toBe(true);
  expect(event.message).toBe(expectedMessage);
  return event;
}

describe.sequential('durable identity preambles', () => {
  it('stores by durable identity, stays offline, and survives legacy files and rebinding', async () => {
    await withE2EFixture(async (fixture) => {
      const bound = await fixture.runJsonCli(['name', 'Durable']);
      expect(bound.code).toBe(0);
      const roleText = 'Role remains separate from the preamble.';
      expect((await fixture.runJsonCli(['role', 'set', roleText])).code).toBe(0);

      const legacyPath = path.join(fixture.workspace, 'tmux-team.json');
      const legacyBytes =
        '{\n  "Durable": {"pane": "%999", "preamble": "legacy"},\n  "LegacyOnly": {"pane": "%998", "preamble": "old"}\n}\n';
      fs.writeFileSync(legacyPath, legacyBytes);
      const unrelated = fixture.createWorkspace('unrelated');
      const malformedBytes = '{ this is intentionally malformed legacy data\n';
      const malformedPath = path.join(unrelated, 'tmux-team.json');
      fs.writeFileSync(malformedPath, malformedBytes);
      const metadataBefore = fixture.paneMetadata();
      const titleBefore = fixture.paneTitle();
      const durableId = identityId(fixture, 'Durable');
      // Non-ASCII text is intentional Unicode transport data, not documentation language.
      const content = 'Use the SQLite profile.\n日本語 survives rebinding.';

      const set = await fixture.runJsonCli<PreambleValue>(['preamble', 'set', 'Durable', content], {
        cwd: unrelated,
        withoutTmux: true,
      });
      expect(json(set)).toEqual({ agent: 'Durable', preamble: content, status: 'set' });
      const shown = await fixture.runJsonCli<PreambleValue>(['preamble', 'show', 'durable'], {
        cwd: unrelated,
        withoutTmux: true,
      });
      expect(json(shown)).toEqual({ agent: 'Durable', preamble: content });
      const listed = await fixture.runJsonCli<{ preambles: PreambleValue[] }>(
        ['preamble', 'show'],
        { cwd: unrelated, withoutTmux: true }
      );
      expect(json(listed)).toEqual({ preambles: [{ agent: 'Durable', preamble: content }] });
      expect(fs.readFileSync(legacyPath, 'utf8')).toBe(legacyBytes);
      expect(fs.readFileSync(malformedPath, 'utf8')).toBe(malformedBytes);
      expect(fixture.paneMetadata()).toBe(metadataBefore);
      expect(fixture.paneTitle()).toBe(titleBefore);
      expect(fs.existsSync(fixture.forbiddenTmuxLogPath)).toBe(false);

      const role = await fixture.runJsonCli<RoleValue>(['role', 'show', '--identity', 'Durable'], {
        cwd: unrelated,
        withoutTmux: true,
      });
      expect(json(role).role?.content).toBe(roleText);

      for (const operation of ['show', 'clear'] as const) {
        const missing = await fixture.runJsonCli<CommandError>(
          ['preamble', operation, 'LegacyOnly'],
          { cwd: unrelated, withoutTmux: true }
        );
        expectError(missing, 'NAME_NOT_FOUND', 3);
      }
      const unknownSet = await fixture.runJsonCli<CommandError>(
        ['preamble', 'set', 'LegacyOnly', 'must not create an identity'],
        { cwd: unrelated, withoutTmux: true }
      );
      expectError(unknownSet, 'NAME_NOT_FOUND', 3);
      const tooLarge = await fixture.runJsonCli<CommandError>(
        ['preamble', 'set', 'Durable', 'x'.repeat(65_537)],
        { cwd: unrelated, withoutTmux: true }
      );
      expectError(tooLarge, 'PREAMBLE_INPUT_TOO_LARGE', 1);
      const invalid = await fixture.runJsonCli<CommandError>(
        ['preamble', 'set', 'Durable', ' \t\n '],
        { cwd: unrelated, withoutTmux: true }
      );
      expectError(invalid, 'PREAMBLE_INPUT_INVALID', 1);
      expect(
        json(
          await fixture.runJsonCli<PreambleValue>(['preamble', 'show', 'Durable'], {
            withoutTmux: true,
          })
        )
      ).toEqual({ agent: 'Durable', preamble: content });
      expect(fs.readFileSync(legacyPath, 'utf8')).toBe(legacyBytes);
      expect(fs.readFileSync(malformedPath, 'utf8')).toBe(malformedBytes);
      expect(fixture.paneMetadata()).toBe(metadataBefore);
      expect(fixture.paneTitle()).toBe(titleBefore);

      expect((await fixture.runJsonCli(['unbind'])).code).toBe(0);
      expect(
        json(
          await fixture.runJsonCli<PreambleValue>(['preamble', 'show', 'Durable'], {
            withoutTmux: true,
          })
        )
      ).toEqual({ agent: 'Durable', preamble: content });
      const replacement = await fixture.createMockPane('replacement');
      expect((await fixture.runJsonCli(['add', replacement.pane, 'durable'])).code).toBe(0);
      fixture.tmux(['kill-pane', '-t', replacement.pane]);
      await fixture.waitFor(
        () => !fixture.mockProcessIsRunning(replacement.pid),
        2_000,
        'replacement pane exit'
      );
      expect(
        json(
          await fixture.runJsonCli<PreambleValue>(['preamble', 'show', 'DURABLE'], {
            withoutTmux: true,
          })
        )
      ).toEqual({ agent: 'Durable', preamble: content });
      await fixture.restartServer();
      expect((await fixture.runJsonCli(['add', fixture.pane, 'Durable'])).code).toBe(0);
      expect(identityId(fixture, 'durable')).toBe(durableId);
      const reboundMetadata = fixture.paneMetadata();
      const reboundTitle = fixture.paneTitle();
      expect(
        json(
          await fixture.runJsonCli<PreambleValue>(['preamble', 'show', 'Durable'], {
            withoutTmux: true,
          })
        )
      ).toEqual({ agent: 'Durable', preamble: content });
      expect(
        json(
          await fixture.runJsonCli<RoleValue>(['role', 'show', '--identity', 'Durable'], {
            withoutTmux: true,
          })
        ).role?.content
      ).toBe(roleText);

      const clear = await fixture.runJsonCli<PreambleValue>(['preamble', 'clear', 'Durable'], {
        withoutTmux: true,
      });
      expect(json(clear)).toEqual({ agent: 'Durable', status: 'cleared' });
      expect(
        json(
          await fixture.runJsonCli<PreambleValue>(['preamble', 'clear', 'Durable'], {
            withoutTmux: true,
          })
        )
      ).toEqual({ agent: 'Durable', status: 'not_set' });
      expect(fixture.paneMetadata()).toBe(reboundMetadata);
      expect(fixture.paneTitle()).toBe(reboundTitle);
      expect(fs.readFileSync(legacyPath, 'utf8')).toBe(legacyBytes);
      expect(
        json(
          await fixture.runJsonCli<RoleValue>(['role', 'show', '--identity', 'Durable'], {
            withoutTmux: true,
          })
        ).role?.content
      ).toBe(roleText);
      expect(fs.existsSync(fixture.forbiddenTmuxLogPath)).toBe(false);
    });
  }, 45_000);

  it('injects causal identity preambles for named and bound targets without advancing skipped counters', async () => {
    await withE2EFixture(async (fixture) => {
      const peer = await fixture.createMockPane('durable-peer');
      expect((await fixture.runJsonCli(['add', peer.pane, 'Peer'])).code).toBe(0);
      const preamble = 'Peer-specific system context';
      expect(
        json(
          await fixture.runJsonCli<PreambleValue>(['preamble', 'set', 'Peer', preamble], {
            withoutTmux: true,
          })
        )
      ).toEqual({ agent: 'Peer', preamble, status: 'set' });
      const setConfig = async (key: string, value: string): Promise<void> => {
        const result = await fixture.runJsonCli(['config', 'set', key, value, '--global'], {
          withoutTmux: true,
        });
        expect(result.code, result.stderr || result.stdout).toBe(0);
      };
      await setConfig('preambleEvery', '2');
      const peerIdentityId = identityId(fixture, 'Peer');
      // Legacy counters were keyed by display name; they must not affect this identity.
      const statePath = path.join(fixture.globalDir, 'state.json');
      fs.writeFileSync(statePath, '{"requests":{},"preambleCounters":{"Peer":99}}\n');

      await causalTalk(fixture, 'Peer', peer.pid, 'first', preamble);
      expect(preambleCounters(fixture)).toEqual({ [peerIdentityId]: 1, Peer: 99 });
      await causalTalk(fixture, 'Peer', peer.pid, 'explicitly raw', undefined, ['--no-preamble']);
      expect(preambleCounters(fixture)).toEqual({ [peerIdentityId]: 1, Peer: 99 });
      const legacyPane = await fixture.createMockPane('legacy-marker');
      fixture.tmux([
        'set-option',
        '-p',
        '-t',
        legacyPane.pane,
        '@tmux-team.agent',
        JSON.stringify({
          version: 1,
          globalIdentity: { name: 'Peer', canonicalName: 'peer' },
          workspaces: {
            [fixture.workspace]: { name: 'Peer', preamble: 'legacy workspace preamble' },
          },
        }),
      ]);
      const legacyMarker = fixture.paneMetadata(legacyPane.pane);
      const legacyPath = path.join(fixture.workspace, 'tmux-team.json');
      const legacyBytes = '{\n  "Peer": {"pane": "%998", "preamble": "legacy"}\n}\n';
      fs.writeFileSync(legacyPath, legacyBytes);
      await causalTalk(fixture, fixture.paneTarget(peer.pane), peer.pid, 'direct second');
      expect(preambleCounters(fixture)).toEqual({ [peerIdentityId]: 2, Peer: 99 });
      await causalTalk(fixture, 'Peer', peer.pid, 'third ordinary', preamble);
      expect(preambleCounters(fixture)).toEqual({ [peerIdentityId]: 3, Peer: 99 });
      expect(fixture.paneMetadata(legacyPane.pane)).toBe(legacyMarker);
      expect(fs.readFileSync(legacyPath, 'utf8')).toBe(legacyBytes);

      await setConfig('preambleEvery', '0');
      await causalTalk(fixture, 'Peer', peer.pid, 'zero disables');
      expect(preambleCounters(fixture)).toEqual({ [peerIdentityId]: 3, Peer: 99 });
      await setConfig('preambleEvery', '2');
      await causalTalk(fixture, 'Peer', peer.pid, 'zero did not advance');
      expect(preambleCounters(fixture)).toEqual({ [peerIdentityId]: 4, Peer: 99 });

      await setConfig('preambleMode', 'disabled');
      await causalTalk(fixture, 'Peer', peer.pid, 'disabled does not advance');
      expect(preambleCounters(fixture)).toEqual({ [peerIdentityId]: 4, Peer: 99 });
      await setConfig('preambleMode', 'always');
      const directBound = fixture.paneTarget(peer.pane);
      // Counter 4 would be skipped; this fifth attempt proves disabled mode did not advance it.
      await causalTalk(fixture, directBound, peer.pid, 'direct bound', preamble);
      expect(preambleCounters(fixture)).toEqual({ [peerIdentityId]: 5, Peer: 99 });
      const unnamed = await fixture.createMockPane('unnamed');
      await causalTalk(fixture, fixture.paneTarget(unnamed.pane), unnamed.pid, 'direct unnamed');
      expect(preambleCounters(fixture)).toEqual({ [peerIdentityId]: 5, Peer: 99 });
      expect(fs.readFileSync(legacyPath, 'utf8')).toBe(legacyBytes);
      expect(fs.existsSync(fixture.forbiddenTmuxLogPath)).toBe(false);
    });
  }, 60_000);
});
