import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { E2EFixture, withE2EFixture } from './harness.js';
import { requestAttempts as attempts, preambleCounters } from './request-state-oracle.js';

interface TalkOutput {
  status: string;
  requestId: string;
  nonce: string;
  response?: string;
  error?: { code: string; stage?: string };
}

function cadence(fixture: E2EFixture): number {
  const counts = Object.values(preambleCounters(fixture));
  expect(counts).toHaveLength(1);
  return counts[0];
}

describe.sequential('transactional live request bookkeeping', () => {
  it('keeps overlapping same-pane waits independent through timeout and interruption', async () => {
    await withE2EFixture(
      async (fixture) => {
        expect((await fixture.runJsonCli(['name', 'Receiver'])).code).toBe(0);
        const legacyPath = path.join(fixture.globalDir, 'state.json');
        const legacyBytes = '{"requests":{"%0":{"id":"old"}},"future":{"keep":true}}\n';
        fs.writeFileSync(legacyPath, legacyBytes);
        const first = fixture.runCliProcess<TalkOutput>([
          '--json',
          'talk',
          'Receiver',
          'first independent wait',
          '--wait',
          '--timeout',
          '8',
        ]);
        const firstEvent = await fixture.waitForEvent(
          (event) => event.event === 'silent' && event.message === 'first independent wait',
          5_000
        );
        const second = fixture.runCliProcess<TalkOutput>([
          '--json',
          'talk',
          fixture.pane,
          'second independent wait',
          '--wait',
          '--timeout',
          '20',
        ]);
        const secondEvent = await fixture.waitForEvent(
          (event) => event.event === 'silent' && event.message === 'second independent wait',
          5_000
        );
        expect(firstEvent.pid).toBe(fixture.panePid);
        expect(secondEvent.pid).toBe(fixture.panePid);
        expect(firstEvent.nonce).not.toBe(secondEvent.nonce);
        await fixture.waitFor(
          () =>
            attempts(fixture).filter((row) => row.wait_active === 1 && row.status === 'sent')
              .length === 2
        );
        const before = attempts(fixture);
        expect(new Set(before.map((row) => row.request_id)).size).toBe(2);
        expect(before.map((row) => row.nonce).sort()).toEqual(
          [firstEvent.nonce, secondEvent.nonce].sort()
        );
        for (const row of before) {
          expect(row).toMatchObject({
            pane_id: fixture.pane,
            pane_pid: fixture.panePid,
            socket_path: fixture.socketPath,
            server_pid: fixture.serverPid,
            status: 'sent',
          });
          expect(row.server_id).not.toBe('');
          expect(row.server_start_time).not.toBe('');
        }

        const timedOut = await first.result;
        expect(timedOut).toMatchObject({
          code: 4,
          json: { status: 'timeout', nonce: firstEvent.nonce },
        });
        const afterFirst = attempts(fixture);
        expect(afterFirst.find((row) => row.nonce === firstEvent.nonce)).toMatchObject({
          wait_active: 0,
          status: 'sent',
        });
        expect(afterFirst.find((row) => row.nonce === secondEvent.nonce)).toMatchObject({
          wait_active: 1,
          status: 'sent',
        });
        second.kill('SIGINT');
        expect((await second.result).code).toBe(1);
        expect(attempts(fixture)).toHaveLength(2);
        expect(
          attempts(fixture).every((row) => row.wait_active === 0 && row.status === 'sent')
        ).toBe(true);
        expect(fs.readFileSync(legacyPath, 'utf8')).toBe(legacyBytes);
      },
      { mode: 'silent' }
    );
  }, 25_000);

  it('separates identical pane IDs on two private servers sharing one database', async () => {
    await withE2EFixture(
      async (firstServer) => {
        const secondServer = new E2EFixture({ globalDir: firstServer.globalDir });
        try {
          await secondServer.start({ mode: 'silent' });
          expect(firstServer.pane).toBe(secondServer.pane);
          expect((await firstServer.runJsonCli(['name', 'First'])).code).toBe(0);
          expect((await secondServer.runJsonCli(['name', 'Second'])).code).toBe(0);
          const first = firstServer.runCliProcess([
            '--json',
            'talk',
            'First',
            'server one wait',
            '--wait',
            '--timeout',
            '20',
          ]);
          const firstEvent = await firstServer.waitForEvent(
            (event) => event.event === 'silent' && event.message === 'server one wait',
            5_000
          );
          const second = secondServer.runCliProcess([
            '--json',
            'talk',
            'Second',
            'server two wait',
            '--wait',
            '--timeout',
            '20',
          ]);
          const secondEvent = await secondServer.waitForEvent(
            (event) => event.event === 'silent' && event.message === 'server two wait',
            5_000
          );
          await firstServer.waitFor(
            () => attempts(firstServer).filter((row) => row.wait_active === 1).length === 2
          );
          const rows = attempts(firstServer);
          expect(rows).toHaveLength(2);
          expect(new Set(rows.map((row) => row.server_id)).size).toBe(2);
          expect(new Set(rows.map((row) => row.socket_path)).size).toBe(2);
          expect(rows.find((row) => row.nonce === firstEvent.nonce)).toMatchObject({
            pane_pid: firstServer.panePid,
            socket_path: firstServer.socketPath,
          });
          expect(rows.find((row) => row.nonce === secondEvent.nonce)).toMatchObject({
            pane_pid: secondServer.panePid,
            socket_path: secondServer.socketPath,
          });
          first.kill('SIGINT');
          expect((await first.result).code).toBe(1);
          expect(
            attempts(firstServer).find((row) => row.nonce === secondEvent.nonce)?.wait_active
          ).toBe(1);
          second.kill('SIGINT');
          expect((await second.result).code).toBe(1);
          expect(attempts(firstServer).every((row) => row.wait_active === 0)).toBe(true);
        } finally {
          await secondServer.stop();
        }
      },
      { mode: 'silent' }
    );
  }, 25_000);

  it('consumes uncertain submit cadence once and preserves the next actual payload', async () => {
    await withE2EFixture(async (fixture) => {
      expect((await fixture.runJsonCli(['name', 'Receiver'])).code).toBe(0);
      expect(
        (await fixture.runJsonCli(['preamble', 'set', 'Receiver', 'Review carefully.'])).code
      ).toBe(0);
      expect((await fixture.runJsonCli(['config', 'set', 'preambleEvery', '3'])).code).toBe(0);
      const uncertain = await fixture.runJsonCli<TalkOutput>(
        ['talk', 'RECEIVER', 'uncertain first input', '--wait', '--timeout', '8'],
        { transportFault: { stage: 'submit' } }
      );
      expect(uncertain).toMatchObject({
        code: 1,
        json: { error: { code: 'DELIVERY_UNCERTAIN', stage: 'submit' } },
      });
      const firstEvent = await fixture.waitForEvent(
        (event) =>
          event.event === 'response' &&
          event.message === '[SYSTEM: Review carefully.]\nuncertain first input'
      );
      expect(firstEvent.pid).toBe(fixture.panePid);
      expect(attempts(fixture)).toHaveLength(1);
      expect(attempts(fixture)[0]).toMatchObject({
        status: 'uncertain',
        wait_active: 0,
        inject_preamble: 1,
        nonce: firstEvent.nonce,
      });
      expect(cadence(fixture)).toBe(1);
      const next = await fixture.runJsonCli<TalkOutput>([
        'talk',
        fixture.pane,
        'second actual input',
        '--wait',
        '--timeout',
        '8',
      ]);
      expect(next).toMatchObject({ code: 0, json: { status: 'completed' } });
      const nextEvent = await fixture.waitForEvent(
        (event) =>
          event.event === 'response' &&
          event.nonce === next.json?.nonce &&
          event.pid === fixture.panePid
      );
      expect(nextEvent.message).toBe('second actual input');
      expect(cadence(fixture)).toBe(2);
      expect(attempts(fixture).find((row) => row.nonce === nextEvent.nonce)).toMatchObject({
        status: 'sent',
        wait_active: 0,
        inject_preamble: 0,
      });
      expect(fixture.events().filter((event) => event.event === 'request')).toHaveLength(2);
      expect(
        fixture.transportTrace().filter((line) => line.startsWith('submit.before'))
      ).toHaveLength(1);
    });
  }, 20_000);
});
