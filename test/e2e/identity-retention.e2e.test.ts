import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { withE2EFixture, type CliResult, type E2EFixture } from './harness.js';

interface IdentityRow {
  id: string;
  name: string;
  canonical_name: string;
}

function identities(fixture: E2EFixture): IdentityRow[] {
  const database = new Database(path.join(fixture.globalDir, 'tmux-team.db'), { readonly: true });
  try {
    return database
      .prepare('SELECT id, name, canonical_name FROM identities ORDER BY canonical_name')
      .all() as IdentityRow[];
  } finally {
    database.close();
  }
}

function success<T>(result: CliResult<T>): T {
  expect(result.code, result.stderr || result.stdout).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.json).toBeDefined();
  return result.json as T;
}

function bindingOwners(fixture: E2EFixture): string[] {
  const database = new Database(path.join(fixture.globalDir, 'tmux-team.db'), { readonly: true });
  try {
    const rows = database
      .prepare('SELECT identity_id FROM bindings ORDER BY identity_id')
      .all() as Array<{ identity_id: string }>;
    return rows.map((row) => row.identity_id);
  } finally {
    database.close();
  }
}

describe.sequential('committed identity retention', () => {
  it('retains a failed binding as offline data and reuses its UUID on a later verified binding', async () => {
    await withE2EFixture(async (fixture) => {
      success(await fixture.runJsonCli(['name', 'Occupied']));
      const initial = identities(fixture);
      const originalMetadata = fixture.paneMetadata();
      const originalTitle = fixture.paneTitle();

      // Both preflight failures must leave durable identity creation untouched.
      const invalid = await fixture.runJsonCli(['name', '%123']);
      expect(invalid.code).toBe(1);
      expect(invalid.json).toMatchObject({ error: { code: 'INVALID_NAME' } });
      const missing = await fixture.runJsonCli(['add', '%99999', 'MissingPane']);
      expect(missing.code).toBe(3);
      expect(missing.json).toMatchObject({ error: { code: 'PANE_NOT_FOUND' } });
      expect(identities(fixture)).toEqual(initial);

      const conflict = await fixture.runJsonCli(['name', 'Retained']);
      expect(conflict.code).toBe(5);
      expect(conflict.stderr).toBe('');
      expect(conflict.json).toEqual({
        error: { code: 'PANE_ALREADY_BOUND', message: 'Pane is already bound to another name.' },
      });
      const rows = identities(fixture);
      expect(rows.map((row) => row.name)).toEqual(['Occupied', 'Retained']);
      const retained = rows[1];
      expect(retained.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(rows[0]).toEqual(initial[0]);
      // Inspect before reconciliation could remove a wrongly published row.
      expect(bindingOwners(fixture)).toEqual([initial[0].id]);
      expect(fixture.paneMetadata()).toBe(originalMetadata);
      expect(fixture.paneTitle()).toBe(originalTitle);

      const list = success(
        await fixture.runJsonCli<{ identities: Array<{ name: string }> }>(['list'])
      );
      expect(list.identities.map((identity) => identity.name)).toEqual(['Occupied']);
      const beforeEvents = fixture.events();
      const inactive = await fixture.runJsonCli(['talk', 'Retained', 'must not be delivered']);
      expect(inactive.code).toBe(3);
      expect(inactive.json).toMatchObject({ error: { code: 'NAME_NOT_FOUND' } });
      expect(fixture.events()).toEqual(beforeEvents);

      const roleText = 'Data-only role; never inject this text.';
      const preamble = 'Retained identity context';
      const role = success(
        await fixture.runJsonCli<{
          identity: { id: string };
          role: { content: string };
        }>(['role', 'set', roleText, '--identity', 'Retained'], { withoutTmux: true })
      );
      expect(role.identity.id).toBe(retained.id);
      expect(role.role.content).toBe(roleText);
      expect(
        success(
          await fixture.runJsonCli(['preamble', 'set', 'Retained', preamble], {
            withoutTmux: true,
          })
        )
      ).toEqual({ agent: 'Retained', preamble, status: 'set' });

      const repeated = await fixture.runJsonCli(['name', 'RETAINED']);
      expect(repeated.code).toBe(5);
      expect(identities(fixture)).toEqual(rows);
      expect(bindingOwners(fixture)).toEqual([initial[0].id]);
      expect(fixture.paneMetadata()).toBe(originalMetadata);
      expect(fixture.paneTitle()).toBe(originalTitle);
      const peer = await fixture.createMockPane('retained-peer');
      success(await fixture.runJsonCli(['add', peer.pane, 'retained']));
      expect(identities(fixture)).toEqual(rows);
      expect(bindingOwners(fixture)).toEqual(rows.map((row) => row.id).sort());
      const reboundRole = success(
        await fixture.runJsonCli<{
          identity: { id: string };
          role: { content: string };
        }>(['role', 'show', '--identity', 'Retained'], { withoutTmux: true })
      );
      expect(reboundRole).toEqual(role);
      expect(fs.existsSync(fixture.forbiddenTmuxLogPath)).toBe(false);

      const message = 'retained identity can now receive';
      const output = success(
        await fixture.runJsonCli<{ status: string; nonce: string }>([
          'talk',
          'Retained',
          message,
          '--wait',
          '--timeout',
          '8',
        ])
      );
      expect(output.status).toBe('completed');
      expect(output.nonce).toMatch(/^[a-z0-9]+$/);
      // The mock records logical nonblank lines, not the empty separator line.
      const payload = `[SYSTEM: ${preamble}]\n${message}`;
      await fixture.waitForEvent(
        (event) =>
          event.event === 'response' &&
          event.pid === peer.pid &&
          event.nonce === output.nonce &&
          event.message === payload
      );
      const events = fixture.events().filter((event) => event.nonce === output.nonce);
      expect(events.filter((event) => event.event === 'request')).toMatchObject([
        { pid: peer.pid, message: payload },
      ]);
      expect(events.filter((event) => event.event === 'response')).toMatchObject([
        { pid: peer.pid, message: payload },
      ]);
      expect(fixture.paneMetadata()).toBe(originalMetadata);
    });
    // Bounded CLI startups plus one response wait; no fixed sleeps or host tmux.
  }, 30_000);
});
