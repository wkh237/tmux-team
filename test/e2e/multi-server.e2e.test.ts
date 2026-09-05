import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withE2EFixture, type E2EFixture, type CliResult } from './harness.js';

function successful<T>(result: CliResult<T>): T {
  expect(result.code, result.stderr || result.stdout).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.json).toBeDefined();
  return result.json as T;
}

function durableState(fixture: E2EFixture) {
  const database = new Database(path.join(fixture.globalDir, 'tmux-team.db'), { readonly: true });
  try {
    return {
      identities: database.prepare('SELECT * FROM identities ORDER BY id').all(),
      bindings: database.prepare('SELECT * FROM bindings ORDER BY id').all(),
      profiles: database.prepare('SELECT * FROM role_profiles ORDER BY identity_id').all(),
    };
  } finally {
    database.close();
  }
}

async function withTwoServers(callback: (a: E2EFixture, b: E2EFixture) => Promise<void>) {
  const servers: E2EFixture[] = [];
  try {
    await withE2EFixture(async (a) => {
      servers.push(a);
      await withE2EFixture(
        async (b) => {
          servers.push(b);
          expect(a.pane).toBe(b.pane);
          expect(a.socketPath).not.toBe(b.socketPath);
          expect(a.serverPid).not.toBe(b.serverPid);
          await callback(a, b);
        },
        { globalDir: a.globalDir }
      );
    });
  } finally {
    for (const server of servers) {
      await server.waitFor(
        () => !server.serverProcessIsRunning() && !server.mockProcessIsRunning(),
        2_000,
        'both private server and mock process cleanup'
      );
      expect(fs.existsSync(server.root)).toBe(false);
      expect(fs.existsSync(server.socketRoot)).toBe(false);
    }
  }
}

describe.sequential('global identities across isolated tmux servers', () => {
  it('cleans both private servers and their shared storage when a scenario throws', async () => {
    await expect(
      withTwoServers(async (a, b) => {
        successful(await a.runJsonCli(['name', 'Local']));
        successful(await b.runJsonCli(['name', 'Remote']));
        throw new Error('intentional multi-server scenario failure');
      })
    ).rejects.toThrow('intentional multi-server scenario failure');
  });

  it('preserves foreign bindings and refuses a live name collision despite identical pane IDs', async () => {
    await withTwoServers(async (a, b) => {
      successful(await b.runJsonCli(['name', 'Remote']));
      successful(await b.runJsonCli(['role', 'set', 'Keep the remote profile.']));
      const before = durableState(b);
      const remoteMetadata = b.paneMetadata();

      expect(successful(await a.runJsonCli(['list']))).toEqual({ identities: [] });
      expect(durableState(a)).toEqual(before);
      const collision = await a.runJsonCli(['name', 'REMOTE']);
      expect(collision.code).toBe(5);
      expect(collision.json).toMatchObject({ error: { code: 'NAME_ALREADY_ACTIVE' } });
      expect(durableState(a)).toEqual(before);
      expect(a.paneMetadata()).toBe('');
      expect(b.paneMetadata()).toBe(remoteMetadata);

      successful(await a.runJsonCli(['name', 'Local']));
      const local = durableState(a).bindings.filter(
        (row) => (row as { socket_path: string }).socket_path === a.socketPath
      );
      const listB = successful(await b.runJsonCli<{ identities: { name: string }[] }>(['list']));
      expect(listB.identities.map((entry) => entry.name)).toEqual(['Remote']);
      expect(
        durableState(a).bindings.filter(
          (row) => (row as { socket_path: string }).socket_path === a.socketPath
        )
      ).toEqual(local);

      const foreignTalk = await a.runJsonCli(['talk', 'Remote', 'must-not-cross-servers']);
      expect(foreignTalk.code).toBe(3);
      expect(foreignTalk.json).toMatchObject({ error: { code: 'NAME_NOT_FOUND' } });
      const message = 'local-server-only';
      const talk = successful(
        await a.runJsonCli<{ status: string; response: string }>([
          'talk',
          'Local',
          message,
          '--wait',
          '--timeout',
          '10',
        ])
      );
      expect(talk.status).toBe('completed');
      expect(talk.response).toContain(`mock-agent response: ${message}`);
      await a.waitForEvent(
        (event) =>
          event.event === 'response' && event.pid === a.panePid && event.message === message
      );
      expect(b.events().filter((event) => event.event === 'request')).toEqual([]);
    });
  }, 30_000);

  it.each(['hidden socket', 'suspended server'] as const)(
    'fails closed with bounded probing for a %s while its process remains alive',
    async (failure) => {
      await withTwoServers(async (a, b) => {
        successful(await b.runJsonCli(['name', 'Remote']));
        successful(await b.runJsonCli(['role', 'set', 'Preserve on uncertain evidence.']));
        const before = durableState(b);
        const metadata = b.paneMetadata();
        const hiddenSocket = `${b.socketPath}.unreachable`;
        if (failure === 'hidden socket') fs.renameSync(b.socketPath, hiddenSocket);
        else process.kill(b.serverPid, 'SIGSTOP');
        try {
          expect(b.serverProcessIsRunning()).toBe(true);
          expect(successful(await a.runJsonCli(['list']))).toEqual({ identities: [] });
          expect(successful(await a.runJsonCli(['whoami']))).toMatchObject({ bound: false });
          expect(durableState(a)).toEqual(before);
          const started = Date.now();
          const result = await a.runJsonCli(['name', 'Remote']);
          expect(Date.now() - started).toBeLessThan(5_000);
          expect(result.code).toBe(1);
          expect(result.json).toMatchObject({ error: { code: 'RECONCILIATION_FAILED' } });
          expect(durableState(a)).toEqual(before);
          expect(a.paneMetadata()).toBe('');
        } finally {
          if (failure === 'hidden socket') fs.renameSync(hiddenSocket, b.socketPath);
          else process.kill(b.serverPid, 'SIGCONT');
        }
        expect(b.paneMetadata()).toBe(metadata);
        expect(successful(await b.runJsonCli(['whoami']))).toMatchObject({
          bound: true,
          name: 'Remote',
        });
      });
    },
    30_000
  );

  it('reclaims a proven-dead foreign endpoint without replacing the identity or profile', async () => {
    await withTwoServers(async (a, b) => {
      successful(await b.runJsonCli(['name', 'Remote']));
      const profile = successful(await b.runJsonCli(['role', 'set', 'Survive endpoint death.']));
      const before = durableState(b);
      b.tmux(['kill-server']);
      await b.waitFor(() => !b.serverProcessIsRunning(), 2_000, 'foreign server process exit');
      successful(await a.runJsonCli(['name', 'Remote']));
      const after = durableState(a);
      expect(after.identities).toEqual(before.identities);
      expect(after.profiles).toEqual(before.profiles);
      expect(after.bindings).toHaveLength(1);
      expect(after.bindings[0]).toMatchObject({ socket_path: a.socketPath });
      expect(after.bindings).not.toEqual(before.bindings);
      expect(successful(await a.runJsonCli(['role', 'show']))).toEqual(profile);
    });
  }, 30_000);

  it('prunes only the restarted socket while retaining another live server and both durable identities', async () => {
    await withTwoServers(async (a, b) => {
      successful(await a.runJsonCli(['name', 'Local']));
      successful(await a.runJsonCli(['role', 'set', 'Survive local restart.']));
      successful(await b.runJsonCli(['name', 'Remote']));
      const before = durableState(a);
      const foreign = before.bindings.filter(
        (row) => (row as { socket_path: string }).socket_path === b.socketPath
      );
      expect(foreign).toHaveLength(1);
      const oldSocket = a.socketPath;
      await a.restartServer();
      expect(a.socketPath).toBe(oldSocket);
      expect(successful(await a.runJsonCli(['list']))).toEqual({ identities: [] });
      const after = durableState(a);
      expect(after.bindings).toEqual(foreign);
      expect(after.identities).toEqual(before.identities);
      expect(after.profiles).toEqual(before.profiles);
      successful(await a.runJsonCli(['name', 'Local']));
      expect(durableState(a).identities).toEqual(before.identities);
      expect(successful(await b.runJsonCli(['whoami']))).toMatchObject({
        bound: true,
        name: 'Remote',
      });
    });
  }, 30_000);

  it('reclaims a dead foreign pane while its original server and another identity remain alive', async () => {
    await withTwoServers(async (a, b) => {
      successful(await b.runJsonCli(['name', 'Remote']));
      const profile = successful(await b.runJsonCli(['role', 'set', 'Survive pane death.']));
      const peer = await b.createMockPane('survivor');
      successful(await b.runJsonCli(['add', peer.pane, 'Survivor']));
      const before = durableState(b);
      const survivor = before.bindings.filter(
        (row) => (row as { pane_id: string }).pane_id === peer.pane
      );
      expect(survivor).toHaveLength(1);
      b.tmux(['kill-pane', '-t', b.pane]);
      await b.waitFor(() => !b.mockProcessIsRunning(), 2_000, 'foreign pane process exit');
      expect(b.serverProcessIsRunning()).toBe(true);

      expect(successful(await a.runJsonCli(['list']))).toEqual({ identities: [] });
      expect(durableState(a)).toEqual(before);
      successful(await a.runJsonCli(['name', 'Remote']));
      const after = durableState(a);
      expect(after.identities).toEqual(before.identities);
      expect(after.profiles).toEqual(before.profiles);
      expect(after.bindings).toHaveLength(2);
      expect(after.bindings).toContainEqual(survivor[0]);
      expect(successful(await a.runJsonCli(['role', 'show']))).toEqual(profile);
      expect(successful(await b.runJsonCli(['whoami'], { pane: peer.pane }))).toMatchObject({
        bound: true,
        name: 'Survivor',
      });
    });
  }, 30_000);
});
