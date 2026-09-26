import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { withSandbox } from '../../../test/support/cli-process.js';
import { withE2EFixture } from '../../../test/e2e/harness.js';
import { installNativeOffice, unusedLoopbackPort } from './native-office-fixture.js';
import type { DispatchReceipt } from '../src/local/dispatch-contract.js';

test('a direct Office request wakes only the verified recipient once while inbox acceptance remains durable', async ({
  request,
}) => {
  await withSandbox(async (sandbox) => {
    const prefix = await installNativeOffice(sandbox);
    await withE2EFixture(
      async (fixture) => {
        const cli = async <T>(args: string[], outsideTmux = false): Promise<T> => {
          const result = await fixture.runJsonCli<T>(args, { outsideTmux });
          expect(result.code, result.stdout + result.stderr).toBe(0);
          return result.json!;
        };
        const pane = await fixture.createMockPane('recipient');
        const alice = await cli<{ id: string }>(['add', pane.pane, 'Alice', '-s']);
        const offline = await cli<{ identity: { id: string } }>(['identity', 'create', 'Offline']);
        const room = (await cli<{ room: { id: string } }>(['room', 'create', 'Design'])).room;
        await cli(['room', 'join', room.id, '--identity', 'Alice']);
        const started = await cli<{ url: string }>(
          ['office', '--prefix', prefix, 'start', '--port', String(await unusedLoopbackPort())],
          true
        );
        let address = new URL(started.url);
        let token = new URLSearchParams(address.hash.slice(1)).get('token');
        expect(token).toBeTruthy();
        const post = async (body: object) => {
          const response = await request.post(`${address.origin}/api/v1/local/dispatch`, {
            headers: { Authorization: `Bearer ${token}`, Origin: address.origin },
            data: body,
          });
          expect(response.status(), await response.text()).toBe(200);
          return (await response.json()) as DispatchReceipt;
        };
        try {
          const body = {
            operationId: randomUUID(),
            recipientIds: [alice.id],
            room: { kind: 'direct', roomId: room.id },
            message: 'private body must remain in the inbox only',
          };
          const accepted = await post(body);
          const requestId = accepted.items[0]!.requestId;
          expect(accepted.items).toEqual([
            { recipientId: alice.id, requestId, acceptance: 'queued' },
          ]);
          expect(accepted.wake).toEqual({
            status: 'sent',
            paneAttempted: true,
            agentProcessed: null,
          });
          const input = await fixture.waitForEvent(
            (event) => event.event === 'input' && event.line?.includes(requestId) === true
          );
          expect(input.line).toBe(
            `Office request ${requestId} is queued. Read it with: tmt x show ${requestId} --incoming --identity ${alice.id} --json`
          );
          await fixture.waitForEvent(
            (event) => event.event === 'input' && event.pid === input.pid && event.line === ''
          );
          const wakeEvents = fixture.events().filter((event) => event.event === 'input');
          expect(
            fixture
              .events()
              .filter((event) => event.event === 'input' && event.line?.includes(requestId))
          ).toHaveLength(1);
          expect(fixture.events().some((event) => event.line?.includes(body.message))).toBe(false);
          const replay = await post(body);
          expect(replay.items).toEqual(accepted.items);
          expect(replay.wake).toBeUndefined();
          expect(
            fixture
              .events()
              .filter((event) => event.event === 'input' && event.line?.includes(requestId))
          ).toHaveLength(1);
          const incoming = await cli<{ exchange: { roomId: string; prompt: { message: string } } }>(
            ['x', 'show', requestId, '--incoming', '--identity', alice.id],
            true
          );
          expect(incoming.exchange.roomId).toBe(room.id);
          expect(incoming.exchange.prompt.message).toBe(body.message);

          const absent = await post({
            operationId: randomUUID(),
            recipientIds: [offline.identity.id],
            message: 'offline request',
          });
          expect(absent.items[0]!.acceptance).toBe('queued');
          expect(absent.wake).toEqual({
            status: 'unavailable',
            paneAttempted: false,
            agentProcessed: null,
          });
          expect(fixture.events().filter((event) => event.event === 'input')).toEqual(wakeEvents);

          await cli(['office', '--prefix', prefix, 'stop'], true);
          const faulted = await fixture.runJsonCli<{ url: string }>(
            ['office', '--prefix', prefix, 'start', '--port', String(await unusedLoopbackPort())],
            { outsideTmux: true, transportFault: { stage: 'paste' } }
          );
          expect(faulted.code, faulted.stdout + faulted.stderr).toBe(0);
          address = new URL(faulted.json!.url);
          token = new URLSearchParams(address.hash.slice(1)).get('token');
          const uncertainBody = {
            operationId: randomUUID(),
            recipientIds: [alice.id],
            message: 'Paste may already have reached the pane.',
          };
          const uncertain = await post(uncertainBody);
          expect(uncertain.items[0]!.acceptance).toBe('queued');
          expect(uncertain.wake).toEqual({
            status: 'uncertain',
            paneAttempted: true,
            agentProcessed: null,
          });
          const afterFault = fixture.transportTrace();
          expect(
            afterFault.filter((line) => line.startsWith('paste-buffer.fault-after'))
          ).toHaveLength(1);
          expect((await post(uncertainBody)).wake).toBeUndefined();
          expect(fixture.transportTrace()).toEqual(afterFault);
        } finally {
          const stopped = await fixture.runJsonCli(['office', '--prefix', prefix, 'stop'], {
            outsideTmux: true,
          });
          expect(stopped.code, stopped.stdout + stopped.stderr).toBe(0);
        }
      },
      { globalDir: sandbox.globalDir, mode: 'input-log' }
    );
  });
});
