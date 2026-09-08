import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  withE2EFixture,
  type CliResult,
  type E2EFixture,
  type E2EFixtureOptions,
} from './harness.js';
import { durableState } from './identity-state-oracle.js';
import { requestAttempts, requestResponses, type AttemptRow } from './request-state-oracle.js';

interface Identity {
  readonly id: string;
  readonly name: string;
  readonly canonicalName: string;
  readonly lifetime: 'saved' | 'temporary';
}

interface TalkOutput {
  readonly status?: string;
  readonly requestId?: string;
  readonly response?: string;
  readonly bodyBytes?: number;
  readonly submittedAtMs?: number;
  readonly identity?: Identity;
  readonly error?: { readonly code?: string; readonly message?: string };
}

interface AttentionAttemptRow extends AttemptRow {
  readonly attention_revision: number;
  readonly attention_acknowledged_revision: number;
}

function options(extra: E2EFixtureOptions = {}): E2EFixtureOptions {
  const native = process.env.TMT_TEST_NATIVE_CLI;
  if (!native) throw new Error('Native exchange-attention E2E requires the Docker-built CLI.');
  return {
    mode: 'respond',
    executableEnv: { TMT_TEST_CLI: native },
    ...extra,
  };
}

function success<T>(result: CliResult<T>): T {
  expect(result.code, result.stderr || result.stdout).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.json).toBeDefined();
  return result.json as T;
}

function attentionAttempt(fixture: E2EFixture, requestId: string): AttentionAttemptRow {
  const attempt = requestAttempts(fixture).find((row) => row.request_id === requestId);
  expect(attempt).toBeDefined();
  return attempt as AttentionAttemptRow;
}

describe.sequential('native exchange attention through Docker/tmux', () => {
  it('keeps implicit attribution, explicit offline attention, watermark cutoffs, and late revisions causal', async () => {
    const original = 'native attention original prompt';
    const body = '\uFEFFlate native final\r\n日本語🙂  ';

    await withE2EFixture(
      async (fixture) => {
        const created = success(
          await fixture.runJsonCli<{ identity: Identity; created: boolean }>(
            ['identity', 'create', 'AttentionOwner'],
            { withoutTmux: true }
          )
        );
        expect(created).toMatchObject({
          created: true,
          identity: {
            id: expect.any(String),
            name: 'AttentionOwner',
            canonicalName: 'attentionowner',
            lifetime: 'saved',
          },
        });
        expect(success(await fixture.runJsonCli(['name', 'AttentionOwner']))).toMatchObject({
          bound: true,
          name: 'AttentionOwner',
          pane: fixture.pane,
        });

        const detached = success(
          await fixture.runJsonCli<TalkOutput>([
            'talk',
            fixture.pane,
            original,
            '--no-preamble',
            '--detach',
          ])
        );
        expect(detached).toMatchObject({
          status: 'sent',
          requestId: expect.stringMatching(/^req_[0-9a-f-]+$/),
        });
        const requestId = detached.requestId!;
        const requestEvent = await fixture.waitForEvent(
          (event) => event.event === 'request' && event.requestId === requestId,
          5_000
        );
        expect(requestEvent.message).toBe(original);
        expect(fixture.events().some((event) => event.event === 'child-start')).toBe(false);

        const initialAttempt = attentionAttempt(fixture, requestId);
        expect(initialAttempt).toMatchObject({
          request_id: requestId,
          originator_kind: 'verified',
          originator_identity_id: created.identity.id,
          message_text: original,
          message_bytes: Buffer.byteLength(original),
          attention_revision: 1,
          attention_acknowledged_revision: 0,
        });
        expect(requestResponses(fixture)).toEqual([]);
        expect(
          fixture
            .events()
            .filter((event) => event.event === 'submitted' && event.requestId === requestId)
        ).toHaveLength(0);

        // Remove caller binding before all attention reads: explicit saved identity selection is
        // storage-only and must work offline without silently falling back to pane discovery.
        expect(success(await fixture.runJsonCli(['unbind']))).toMatchObject({
          unbound: true,
          name: 'AttentionOwner',
        });
        expect(durableState(fixture).bindings).toEqual([]);

        // This is deliberately the first x operation; ackall uses its identity watermark and
        // does not require a preceding list, show, token, or body read.
        const acknowledged = success<{ identity: Identity; acknowledgedThrough: number }>(
          await fixture.runJsonCli(['x', 'ackall', '--identity', 'attentionowner'], {
            withoutTmux: true,
          })
        );
        expect(acknowledged).toEqual({
          identity: created.identity,
          acknowledgedThrough: 1,
        });
        expect(attentionAttempt(fixture, requestId).attention_acknowledged_revision).toBe(0);

        const beforeFinal = success<{
          identity: Identity;
          items: unknown[];
          nextAfter: number | null;
        }>(
          await fixture.runJsonCli(['x', 'list', '--identity', 'AttentionOwner'], {
            withoutTmux: true,
          })
        );
        expect(beforeFinal).toEqual({
          identity: created.identity,
          items: [],
          nextAfter: null,
        });

        fixture.releaseReplyGate(requestId);
        await fixture.waitForEvent(
          (event) => event.event === 'child-start' && event.requestId === requestId,
          5_000
        );
        const submitted = await fixture.waitForEvent(
          (event) => event.event === 'submitted' && event.requestId === requestId,
          5_000
        );
        expect(submitted.body).toBe(body);
        expect(submitted.bodyBytes).toBe(Buffer.byteLength(body));
        expect(requestResponses(fixture)).toEqual([
          expect.objectContaining({
            request_id: requestId,
            body,
            submitted_at_ms: submitted.submittedAtMs,
          }),
        ]);

        const reopened = success<{
          identity: Identity;
          items: Array<{
            requestId: string;
            revision: number;
            acknowledged: boolean;
            settled: boolean;
            final: Record<string, unknown>;
          }>;
          nextAfter: number | null;
        }>(
          await fixture.runJsonCli(['x', 'list', '--identity', 'AttentionOwner'], {
            withoutTmux: true,
          })
        );
        expect(reopened.identity).toEqual(created.identity);
        expect(reopened.items).toEqual([
          expect.objectContaining({
            requestId,
            preparedAtMs: expect.any(Number),
            delivery: 'sent',
            final: {
              status: 'retained',
              submittedAtMs: expect.any(Number),
              bodyBytes: Buffer.byteLength(body),
              expiresAtMs: expect.any(Number),
            },
            revision: 2,
            acknowledged: false,
            settled: false,
            retentionExpiresAtMs: expect.any(Number),
          }),
        ]);
        expect(reopened.nextAfter).toBeNull();
        expect(reopened.items[0].final).not.toHaveProperty('response');
        expect(reopened.items[0]).not.toHaveProperty('prompt');
        expect(attentionAttempt(fixture, requestId)).toMatchObject({
          attention_revision: 2,
          attention_acknowledged_revision: 0,
        });

        const stale = await fixture.runJsonCli<TalkOutput>(
          ['x', 'ack', requestId, '--identity', 'AttentionOwner', '--revision', '1'],
          { withoutTmux: true }
        );
        expect(stale).toMatchObject({
          code: 5,
          stderr: '',
          json: { error: { code: 'X_REVISION_CONFLICT' } },
        });
        expect(attentionAttempt(fixture, requestId).attention_acknowledged_revision).toBe(0);

        const current = success<{
          identity: Identity;
          requestId: string;
          revision: number;
          changed: boolean;
        }>(
          await fixture.runJsonCli(
            ['x', 'ack', requestId, '--identity', 'AttentionOwner', '--revision', '2'],
            { withoutTmux: true }
          )
        );
        expect(current).toEqual({
          identity: created.identity,
          requestId,
          revision: 2,
          acknowledged: true,
          changed: true,
        });
        expect(attentionAttempt(fixture, requestId).attention_acknowledged_revision).toBe(2);

        const shown = success<{
          identity: Identity;
          exchange: {
            requestId: string;
            acknowledged: boolean;
            settled: boolean;
            prompt: { status: string; message: string; messageBytes: number };
            final: {
              status: string;
              response?: string;
              bodyBytes?: number;
              submittedAtMs?: number;
              expiresAtMs?: number;
            };
          };
        }>(
          await fixture.runJsonCli(['x', 'show', requestId, '--identity', 'AttentionOwner'], {
            withoutTmux: true,
          })
        );
        expect(shown).toEqual({
          identity: created.identity,
          exchange: {
            requestId,
            recipientIdentityId: created.identity.id,
            preparedAtMs: expect.any(Number),
            delivery: 'sent',
            final: {
              status: 'retained',
              response: body,
              bodyBytes: Buffer.byteLength(body),
              submittedAtMs: submitted.submittedAtMs,
              expiresAtMs: expect.any(Number),
            },
            revision: 2,
            acknowledged: true,
            settled: true,
            retentionExpiresAtMs: expect.any(Number),
            prompt: {
              status: 'retained',
              message: original,
              messageBytes: Buffer.byteLength(original),
              expiresAtMs: expect.any(Number),
            },
          },
        });
        // Rebinding the same saved UUID restores implicit access to the same
        // retained exchange, without a second identity or attention owner.
        success(await fixture.runJsonCli(['name', 'AttentionOwner']));
        expect(success(await fixture.runJsonCli(['x', 'show', requestId]))).toEqual(shown);
        expect(
          fixture
            .events()
            .filter((event) => event.event === 'request' && event.requestId === requestId)
        ).toHaveLength(1);
        expect(
          fixture
            .events()
            .filter((event) => event.event === 'child-start' && event.requestId === requestId)
        ).toHaveLength(1);
        expect(
          fixture
            .events()
            .filter((event) => event.event === 'submitted' && event.requestId === requestId)
        ).toHaveLength(1);
        expect(fs.existsSync(fixture.forbiddenTmuxLogPath)).toBe(false);
      },
      options({ replyGate: true, responseBodyBase64: Buffer.from(body).toString('base64') })
    );
  }, 25_000);
});
