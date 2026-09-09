import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { expectJsonResult } from './cli-assertions.js';
import { withE2EFixture, type E2EFixture } from './harness.js';

interface PublicIdentity {
  readonly id: string;
  readonly name: string;
  readonly canonicalName: string;
}

interface TalkResult {
  readonly status?: string;
  readonly requestId?: string;
  readonly error?: { readonly code?: string };
}

function malformedConfig(fixture: E2EFixture): { global: string; local: string } {
  const global = '{ malformed exchange config';
  const local = '{ malformed local exchange config';
  fs.writeFileSync(path.join(fixture.globalDir, 'config.json'), global);
  fs.writeFileSync(path.join(fixture.workspace, 'tmux-team.json'), local);
  return { global, local };
}

async function calibrateOfflineTmuxGuard(fixture: E2EFixture): Promise<void> {
  const calibration = await fixture.runJsonCli(['check', fixture.pane], { withoutTmux: true });
  expect(calibration.code).toBe(3);
  expect(calibration.json).toMatchObject({ error: { code: 'PANE_NOT_FOUND' } });
  expect(fs.existsSync(fixture.forbiddenTmuxLogPath)).toBe(true);
  fs.rmSync(fixture.forbiddenTmuxLogPath, { force: true });
}

describe.sequential('Exchange attention through the real Docker/tmux fixture', () => {
  it('ackall works before any list, late finals reopen attention, and explicit/implicit identity access survives rebind', async () => {
    await withE2EFixture(
      async (fixture) => {
        const created = expectJsonResult(
          await fixture.runJsonCli<{ identity: PublicIdentity; created: boolean }>(
            ['identity', 'create', 'Alice'],
            { withoutTmux: true }
          )
        );
        expect(created.created).toBe(true);
        await calibrateOfflineTmuxGuard(fixture);

        const detached = expectJsonResult(
          await fixture.runJsonCli<TalkResult>([
            'talk',
            fixture.pane,
            'late attention final',
            '--identity',
            'alice',
            '--no-preamble',
            '--detach',
          ])
        );
        expect(detached).toMatchObject({
          status: 'sent',
          requestId: expect.stringMatching(/^req_/),
        });
        const requestId = detached.requestId!;
        await fixture.waitForEvent(
          (event) => event.event === 'request' && event.requestId === requestId
        );

        // The acknowledgement is intentionally the first exchange read: ackall must use only
        // the identity watermark and cannot depend on a preceding list or body lookup.
        const acknowledged = expectJsonResult(
          await fixture.runJsonCli<{ identity: PublicIdentity; acknowledgedThrough: number }>(
            ['x', 'ackall', '--identity', 'alice'],
            { withoutTmux: true }
          )
        );
        expect(acknowledged.identity).toEqual(created.identity);
        expect(acknowledged.acknowledgedThrough).toBeGreaterThan(0);

        const configs = malformedConfig(fixture);
        fixture.releaseReplyGate(requestId);
        const submitted = await fixture.waitForEvent(
          (event) => event.event === 'submitted' && event.requestId === requestId,
          5_000
        );
        expect(submitted.body).toBe('mock-agent response: late attention final');

        const reopened = expectJsonResult<{
          identity: PublicIdentity;
          items: Array<Record<string, unknown>>;
          nextAfter: number | null;
        }>(await fixture.runJsonCli(['x', 'list', '--identity', 'alice'], { withoutTmux: true }));
        expect(reopened.identity).toEqual(created.identity);
        expect(reopened.items).toEqual([
          expect.objectContaining({
            requestId,
            acknowledged: false,
            final: {
              status: 'retained',
              bodyBytes: Buffer.byteLength(submitted.body!),
              submittedAtMs: expect.any(Number),
              expiresAtMs: expect.any(Number),
            },
          }),
        ]);
        expect(JSON.stringify(reopened)).not.toContain('attemptId');
        expect(JSON.stringify(reopened)).not.toContain('socketPath');

        const exact = expectJsonResult<{
          identity: PublicIdentity;
          exchange: { final: { status: string; response?: string; bodyBytes?: number } };
        }>(
          await fixture.runJsonCli(['x', 'show', requestId, '--identity', 'alice'], {
            withoutTmux: true,
          })
        );
        expect(exact.identity).toEqual(created.identity);
        expect(exact.exchange.final).toEqual({
          status: 'retained',
          response: submitted.body,
          bodyBytes: Buffer.byteLength(submitted.body!),
          submittedAtMs: expect.any(Number),
          expiresAtMs: expect.any(Number),
        });
        expect(fs.existsSync(fixture.forbiddenTmuxLogPath)).toBe(false);

        // Bind the same durable identity and prove omitted --identity uses verified caller
        // evidence. The explicit offline path above never touched tmux or parsed config.
        const bindWithValidSettings = async (name: string, pane: string): Promise<void> => {
          // Binding now validates badge configuration. Repair only for that operation,
          // then restore malformed settings before each implicit exchange read below.
          expect(fs.readFileSync(path.join(fixture.globalDir, 'config.json'), 'utf8')).toBe(
            configs.global
          );
          expect(fs.readFileSync(path.join(fixture.workspace, 'tmux-team.json'), 'utf8')).toBe(
            configs.local
          );
          fs.writeFileSync(path.join(fixture.globalDir, 'config.json'), '{}');
          fs.writeFileSync(path.join(fixture.workspace, 'tmux-team.json'), '{}');
          expect(expectJsonResult(await fixture.runJsonCli(['name', name]))).toEqual({
            bound: true,
            id: created.identity.id,
            lifetime: 'saved',
            name: 'Alice',
            pane,
          });
          expect(malformedConfig(fixture)).toEqual(configs);
        };
        await bindWithValidSettings('Alice', fixture.pane);
        const implicit = expectJsonResult<{ items: Array<Record<string, unknown>> }>(
          await fixture.runJsonCli(['x', 'list'])
        );
        expect(implicit.items.some((item) => item.requestId === requestId)).toBe(true);

        const restarted = await fixture.restartServer();
        await bindWithValidSettings('alice', restarted.pane);
        const afterRebind = expectJsonResult<{ identity: PublicIdentity }>(
          await fixture.runJsonCli(['x', 'show', requestId])
        );
        expect(afterRebind.identity).toEqual(created.identity);

        expect(fs.readFileSync(path.join(fixture.globalDir, 'config.json'), 'utf8')).toBe(
          configs.global
        );
        expect(fs.readFileSync(path.join(fixture.workspace, 'tmux-team.json'), 'utf8')).toBe(
          configs.local
        );
      },
      { replyGate: true }
    );
  }, 45_000);
  it('recovers a timed-out explicit exchange and shows the exact virtualized final body without reading the terminal', async () => {
    await withE2EFixture(
      async (fixture) => {
        const created = expectJsonResult(
          await fixture.runJsonCli<{ identity: PublicIdentity; created: boolean }>(
            ['identity', 'create', 'VirtualizedOwner'],
            { withoutTmux: true }
          )
        );
        expect(created.created).toBe(true);
        await calibrateOfflineTmuxGuard(fixture);
        const token = 'exchange-virtualized-final-🙂-日本語';
        const expectedBody = [
          `VIRTUALIZED-BEGIN:${token}`,
          ...Array.from(
            { length: 200 },
            (_, index) => `VIRTUALIZED-LINE-${String(index + 1).padStart(3, '0')}:${token}`
          ),
          `VIRTUALIZED-END:${token}`,
        ].join('\n');

        const timedOut = await fixture.runJsonCli<TalkResult>([
          'talk',
          fixture.pane,
          token,
          '--identity',
          'virtualizedowner',
          '--no-preamble',
          '--timeout',
          '1',
        ]);
        expect(timedOut.code).toBe(4);
        expect(timedOut.json).toMatchObject({
          status: 'timeout',
          requestId: expect.stringMatching(/^req_[0-9a-f-]+$/),
          error: { code: 'TIMEOUT' },
        });
        const requestId = timedOut.json?.requestId;
        expect(requestId).toBeDefined();
        expect(
          fixture
            .events()
            .some((event) => event.event === 'submitted' && event.requestId === requestId)
        ).toBe(false);
        fixture.releaseReplyGate(requestId);
        const submitted = await fixture.waitForEvent(
          (event) => event.event === 'submitted' && event.requestId === requestId,
          5_000
        );
        expect(submitted.body).toBe(expectedBody);

        const listed = expectJsonResult<{
          items: Array<{
            requestId: string;
            revision: number;
            acknowledged: boolean;
            final: Record<string, unknown>;
          }>;
        }>(
          await fixture.runJsonCli(['x', 'list', '--identity', 'virtualizedowner'], {
            withoutTmux: true,
          })
        );
        const item = listed.items.find((candidate) => candidate.requestId === requestId);
        expect(item).toMatchObject({
          requestId,
          acknowledged: false,
          final: { status: 'retained', bodyBytes: Buffer.byteLength(expectedBody) },
        });
        expect(item?.revision).toBeGreaterThan(1);

        const acked = expectJsonResult<{ changed: boolean; revision: number }>(
          await fixture.runJsonCli(
            [
              'x',
              'ack',
              requestId!,
              '--identity',
              'virtualizedowner',
              '--revision',
              String(item!.revision),
            ],
            { withoutTmux: true }
          )
        );
        expect(acked).toMatchObject({ changed: true, revision: item!.revision });

        const shown = expectJsonResult<{
          exchange: {
            acknowledged: boolean;
            settled: boolean;
            final: { status: string; response?: string; bodyBytes?: number };
          };
        }>(
          await fixture.runJsonCli(['x', 'show', requestId!, '--identity', 'virtualizedowner'], {
            withoutTmux: true,
          })
        );
        expect(shown.exchange.acknowledged).toBe(true);
        expect(shown.exchange.settled).toBe(true);
        expect(shown.exchange.final).toEqual({
          status: 'retained',
          response: expectedBody,
          bodyBytes: Buffer.byteLength(expectedBody),
          submittedAtMs: expect.any(Number),
          expiresAtMs: expect.any(Number),
        });
        expect(fs.existsSync(fixture.forbiddenTmuxLogPath)).toBe(false);
        expect(fixture.capture()).not.toContain(`VIRTUALIZED-LINE-100:${token}`);
      },
      { mode: 'virtualized', replyGate: true }
    );
  }, 30_000);
});
