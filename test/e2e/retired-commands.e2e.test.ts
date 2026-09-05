import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withE2EFixture, type E2EFixture } from './harness.js';

const RETIRED_COMMANDS = [
  ['update', 'SharedIdentity', '--pane', '%999', '--remark', 'must not update'],
  ['remove', 'SharedIdentity'],
  ['rm', 'SharedIdentity'],
  ['migrate'],
  ['migrate', '--dry-run'],
  ['migrate', '--cleanup'],
  ['migrate', '--dry-run', '--cleanup'],
] as const;

const HELP_NEIGHBORS = [
  'talk',
  'check',
  'list',
  'add',
  'name',
  'this',
  'whoami',
  'unbind',
  'install',
  'upgrade',
  'init',
  'completion',
  'config',
  'preamble',
  'role',
  'learn',
  'help',
] as const;

interface DurableSnapshot {
  identities: unknown[];
  bindings: unknown[];
  profiles: unknown[];
  migrations: unknown[];
}

function databasePath(fixture: E2EFixture): string {
  return path.join(fixture.globalDir, 'tmux-team.db');
}

function durableSnapshot(fixture: E2EFixture): DurableSnapshot {
  const database = new Database(databasePath(fixture), { readonly: true });
  try {
    return {
      identities: database
        .prepare('SELECT * FROM identities ORDER BY canonical_name')
        .all() as unknown[],
      bindings: database.prepare('SELECT * FROM bindings ORDER BY id').all() as unknown[],
      profiles: database
        .prepare('SELECT * FROM role_profiles ORDER BY identity_id')
        .all() as unknown[],
      migrations: database.prepare('SELECT * FROM _migrations ORDER BY version').all() as unknown[],
    };
  } finally {
    database.close();
  }
}

function expectUnknownCommandHuman(result: { code: number; stdout: string; stderr: string }): void {
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toMatch(/unknown command/i);
}

function expectUnknownCommandJson(result: { code: number; stdout: string; stderr: string }): void {
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(() => JSON.parse(result.stderr)).not.toThrow();
  expect(JSON.parse(result.stderr)).toEqual({ error: expect.stringMatching(/unknown command/i) });
}

function expectRetiredNamesAndFlagsAbsent(output: string, shell?: 'bash' | 'zsh'): void {
  for (const flag of ['--pane', '--remark', '--dry-run', '--cleanup']) {
    expect(output).not.toContain(flag);
  }
  if (!shell) {
    expect(output).not.toMatch(/^\s+(?:update|remove|rm|migrate)\b/m);
    return;
  }
  if (shell === 'zsh') {
    expect(output).not.toMatch(/'(?:update|remove|rm|migrate):/);
    expect(output).not.toMatch(/(?:update|remove|rm|migrate)\)/);
    return;
  }
  expect(output).not.toMatch(/commands="[^"]*\b(?:update|remove|rm|migrate)\b/);
  expect(output).not.toMatch(/(?:update|remove|rm|migrate)\|/);
}

function expectNeighborsPresent(output: string, shell?: 'bash' | 'zsh'): void {
  for (const neighbor of HELP_NEIGHBORS) {
    if (!shell) {
      expect(output).toMatch(new RegExp(`^\\s+${neighbor}\\b`, 'm'));
    } else if (shell === 'zsh') {
      expect(output).toContain(`'${neighbor}:`);
    } else {
      expect(output).toMatch(new RegExp(`commands="[^\\"]*\\b${neighbor}\\b`));
    }
  }
}

describe.sequential('retired legacy registry commands', () => {
  it('rejects every retired command and flag before opening resources', async () => {
    await withE2EFixture(async (fixture) => {
      expect(fs.existsSync(databasePath(fixture))).toBe(false);

      for (const args of RETIRED_COMMANDS) {
        const human = await fixture.runCli([...args], { withoutTmux: true });
        expectUnknownCommandHuman(human);
      }

      expect(fs.existsSync(databasePath(fixture))).toBe(false);
      expect(fs.existsSync(fixture.forbiddenTmuxLogPath)).toBe(false);
    });
  });

  it('rejects retired commands in human and JSON modes without changing legacy, metadata, or SQLite state', async () => {
    await withE2EFixture(async (fixture) => {
      const peer = await fixture.createMockPane('peer');
      expect((await fixture.runJsonCli(['name', 'SharedIdentity'])).code).toBe(0);
      expect((await fixture.runJsonCli(['add', peer.pane, 'PeerIdentity'])).code).toBe(0);
      expect((await fixture.runJsonCli(['role', 'set', 'Shared profile'])).code).toBe(0);
      expect(
        (await fixture.runJsonCli(['role', 'set', 'Peer profile', '--identity', 'PeerIdentity']))
          .code
      ).toBe(0);

      const sharedMetadata = JSON.parse(fixture.paneMetadata(fixture.pane)) as {
        version: 1;
        globalIdentity: Record<string, unknown>;
        workspaces?: Record<string, unknown>;
      };
      sharedMetadata.workspaces = {
        [fixture.workspace]: { name: 'SharedIdentity', remark: 'workspace metadata' },
      };
      fixture.tmux([
        'set-option',
        '-p',
        '-t',
        fixture.pane,
        '@tmux-team.agent',
        JSON.stringify(sharedMetadata),
      ]);

      const legacyPath = path.join(fixture.workspace, 'tmux-team.json');
      const legacyBytes =
        '{\n  "SharedIdentity": {"pane": "' + fixture.pane + '", "remark": "legacy JSON"}\n}\n';
      fs.writeFileSync(legacyPath, legacyBytes);

      const metadataBefore = new Map([
        [fixture.pane, fixture.paneMetadata(fixture.pane)],
        [peer.pane, fixture.paneMetadata(peer.pane)],
      ]);
      const durableBefore = durableSnapshot(fixture);

      for (const args of RETIRED_COMMANDS) {
        const human = await fixture.runCli([...args]);
        expectUnknownCommandHuman(human);
        const json = await fixture.runJsonCli([...args]);
        expectUnknownCommandJson(json);
      }

      expect(fs.readFileSync(legacyPath, 'utf8')).toBe(legacyBytes);
      expect(fixture.paneMetadata(fixture.pane)).toBe(metadataBefore.get(fixture.pane));
      expect(fixture.paneMetadata(peer.pane)).toBe(metadataBefore.get(peer.pane));
      expect(durableSnapshot(fixture)).toEqual(durableBefore);
      expect(fs.existsSync(fixture.forbiddenTmuxLogPath)).toBe(false);
      const message = 'update remove rm migrate --dry-run --cleanup remain message data';
      const result = await fixture.runJsonCli<{
        pane: string;
        identity: { name: string };
        status: string;
        response: string;
      }>(['talk', 'SharedIdentity', '--wait', '--timeout', '10', '--', message]);
      expect(result.code).toBe(0);
      expect(result.json).toMatchObject({
        pane: fixture.pane,
        identity: { name: 'SharedIdentity' },
        status: 'completed',
      });
      expect(result.json?.response).toContain(`mock-agent response: ${message}`);

      await fixture.waitForEvent(
        (event) =>
          event.event === 'response' && event.pid === fixture.panePid && event.message === message
      );
      const events = fixture.events();
      expect(
        events.some(
          (event) =>
            event.event === 'request' && event.pid === fixture.panePid && event.message === message
        )
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            (event.event === 'request' || event.event === 'response') &&
            event.pid === peer.pid &&
            event.message === message
        )
      ).toBe(false);
    });
  }, 30_000);

  it('omits retired names and flags from help and shell completion while retaining neighboring commands', async () => {
    await withE2EFixture(async (fixture) => {
      const help = await fixture.runCli(['help'], { withoutTmux: true });
      expect(help.code).toBe(0);
      expectNeighborsPresent(help.stdout);
      expectRetiredNamesAndFlagsAbsent(help.stdout);

      for (const shell of ['bash', 'zsh']) {
        const completion = await fixture.runCli(['completion', shell], { withoutTmux: true });
        expect(completion.code).toBe(0);
        expectNeighborsPresent(completion.stdout, shell as 'bash' | 'zsh');
        expectRetiredNamesAndFlagsAbsent(completion.stdout, shell as 'bash' | 'zsh');
      }
    });
  });
});
