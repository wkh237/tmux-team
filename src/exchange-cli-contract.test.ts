import fs, { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRequestService } from './request-service.js';
import { openIdentityRepository } from './storage/identity-repository.js';
import {
  expectError,
  expectJsonSuccess,
  parseWholeStdout,
  runCli,
  withSandbox,
  type Sandbox,
} from './test-support/cli-process.js';

const endpoint = {
  serverId: 'exchange-contract-server',
  socketPath: '/tmp/exchange-contract.sock',
  serverPid: 1234,
  serverStartTime: 'exchange-contract-start',
  paneId: '%1',
  panePid: 5678,
} as const;

interface SeededExchange {
  readonly identityId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly revision: number;
}

async function calibratedTmuxGuard(sandbox: Sandbox): Promise<string> {
  const logPath = forbidTmux(sandbox);
  const calibration = await runCli(sandbox, ['list', '--json']);
  expect(calibration.status).toBe(1);
  expect(existsSync(logPath)).toBe(true);
  fs.rmSync(logPath, { force: true });
  return logPath;
}

function forbidTmux(sandbox: Sandbox): string {
  const wrapperDirectory = path.join(sandbox.root, 'forbidden-bin');
  const logPath = path.join(sandbox.root, 'tmux-invocations.log');
  mkdirSync(wrapperDirectory);
  const wrapperPath = path.join(wrapperDirectory, 'tmux');
  writeFileSync(
    wrapperPath,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TMT_EXCHANGE_TMUX_LOG"\nexit 97\n'
  );
  chmodSync(wrapperPath, 0o755);
  sandbox.env.PATH = `${wrapperDirectory}${path.delimiter}${process.env.PATH ?? ''}`;
  sandbox.env.TMT_EXCHANGE_TMUX_LOG = logPath;
  return logPath;
}

function seedExchange(
  sandbox: Sandbox,
  identityName: string,
  requestId: string,
  options: { readonly final?: string } = {}
): SeededExchange {
  const repository = openIdentityRepository(sandbox.database);
  try {
    const identity =
      repository.findByCanonicalName(identityName.toLowerCase()) ??
      repository.createIdentity(identityName, identityName.toLowerCase());
    const service = createRequestService({ repository, now: () => Date.now() });
    const prepared = service.prepare({
      requestId,
      message: `prompt for ${requestId}`,
      endpoint,
      wait: false,
      expiresAtMs: Date.now() + 60 * 60 * 1000,
      originator: { kind: 'explicit', identityId: identity.id },
      recipientIdentityId: 'recipient-identity',
    });
    service.beginSend(prepared.attemptId);
    service.settle(prepared.attemptId, 'sent');
    if (options.final !== undefined) {
      service.submitResponse({
        requestId,
        attemptId: prepared.attemptId,
        endpoint,
        body: options.final,
      });
    }
    const shown = service.showExchange(identity.id, requestId);
    return {
      identityId: identity.id,
      requestId,
      attemptId: prepared.attemptId,
      revision: shown.revision,
    };
  } finally {
    repository.close();
  }
}

function submitFinal(sandbox: Sandbox, seeded: SeededExchange, body: string): void {
  const repository = openIdentityRepository(sandbox.database);
  try {
    const service = createRequestService({ repository, now: () => Date.now() });
    service.submitResponse({
      requestId: seeded.requestId,
      attemptId: seeded.attemptId,
      endpoint,
      body,
    });
  } finally {
    repository.close();
  }
}

function malformedConfig(sandbox: Sandbox): { global: string; local: string } {
  const global = '{ malformed global config';
  const local = '{ malformed local config';
  mkdirSync(sandbox.globalDir, { recursive: true });
  fs.writeFileSync(sandbox.globalConfig, global);
  fs.writeFileSync(sandbox.localConfig, local);
  return { global, local };
}

describe('real CLI Exchange attention contract', () => {
  it(
    'lists and shows exact retained DTOs storage-only, preserves unread state, and works with malformed config',
    { timeout: 15_000 },
    async () =>
      withSandbox(async (sandbox) => {
        const tmuxLog = await calibratedTmuxGuard(sandbox);
        const configs = malformedConfig(sandbox);
        const created = await runCli(sandbox, ['identity', 'create', 'Alice', '--json']);
        expectJsonSuccess(created, {
          identity: { id: expect.any(String), name: 'Alice', canonicalName: 'alice' },
          created: true,
        });
        const seeded = seedExchange(sandbox, 'Alice', 'req_exchange_1', {
          final: 'exact final body',
        });

        const listed = await runCli(sandbox, [
          'x',
          'list',
          '--identity',
          'alice',
          '--limit',
          '1',
          '--after',
          '0',
          '--json',
        ]);
        expect(listed.status).toBe(0);
        expect(listed.stderr).toBe('');
        const list = parseWholeStdout(listed) as {
          identity: { id: string; name: string; canonicalName: string };
          items: Array<Record<string, unknown>>;
          nextAfter: number | null;
        };
        expect(list.identity).toEqual({
          id: seeded.identityId,
          name: 'Alice',
          canonicalName: 'alice',
        });
        expect(list.items).toHaveLength(1);
        expect(Object.keys(list.items[0]!).sort()).toEqual([
          'acknowledged',
          'delivery',
          'final',
          'preparedAtMs',
          'recipientIdentityId',
          'requestId',
          'retentionExpiresAtMs',
          'revision',
          'settled',
        ]);
        expect(list.items[0]).toMatchObject({
          requestId: seeded.requestId,
          recipientIdentityId: 'recipient-identity',
          delivery: 'sent',
          revision: expect.any(Number),
          acknowledged: false,
          settled: false,
          final: { status: 'retained', bodyBytes: Buffer.byteLength('exact final body') },
        });
        expect(JSON.stringify(list)).not.toContain('attemptId');
        expect(JSON.stringify(list)).not.toContain(endpoint.socketPath);
        expect(JSON.stringify(list)).not.toContain('prompt for');

        const shown = await runCli(sandbox, [
          'x',
          'show',
          seeded.requestId,
          '--identity',
          'alice',
          '--json',
        ]);
        expect(shown.status).toBe(0);
        expect(shown.stderr).toBe('');
        const shownDocument = parseWholeStdout(shown);
        expect(shownDocument).toEqual({
          identity: list.identity,
          exchange: expect.objectContaining({
            requestId: seeded.requestId,
            revision: list.items[0]!.revision,
            acknowledged: false,
            prompt: {
              status: 'retained',
              message: 'prompt for req_exchange_1',
              messageBytes: Buffer.byteLength('prompt for req_exchange_1'),
              expiresAtMs: expect.any(Number),
            },
            final: {
              status: 'retained',
              response: 'exact final body',
              submittedAtMs:
                list.items[0]!.final &&
                (list.items[0]!.final as { submittedAtMs: number }).submittedAtMs,
              bodyBytes: Buffer.byteLength('exact final body'),
              expiresAtMs: (list.items[0]!.final as { expiresAtMs: number }).expiresAtMs,
            },
          }),
        });
        expect(JSON.stringify(shownDocument)).not.toContain('attemptId');
        expect(JSON.stringify(shownDocument)).not.toContain(endpoint.socketPath);

        const repeated = await runCli(sandbox, ['x', 'list', '--identity', 'alice', '--json']);
        expectJsonSuccess(
          repeated,
          expect.objectContaining({
            items: [expect.objectContaining({ requestId: seeded.requestId, acknowledged: false })],
          })
        );
        const pending = seedExchange(sandbox, 'Alice', 'req_exchange_pending');
        const pendingShown = await runCli(sandbox, [
          'x',
          'show',
          pending.requestId,
          '--identity',
          'alice',
          '--json',
        ]);
        expect(pendingShown.status).toBe(0);
        expect(parseWholeStdout(pendingShown)).toEqual({
          identity: list.identity,
          exchange: expect.objectContaining({
            requestId: pending.requestId,
            final: { status: 'not_submitted' },
            prompt: expect.objectContaining({
              status: 'retained',
              message: `prompt for ${pending.requestId}`,
              messageBytes: Buffer.byteLength(`prompt for ${pending.requestId}`),
            }),
          }),
        });
        const pendingAck = await runCli(sandbox, [
          'x',
          'ack',
          pending.requestId,
          '--identity',
          'alice',
          '--revision',
          String(pending.revision),
          '--json',
        ]);
        expectJsonSuccess(pendingAck, {
          identity: list.identity,
          requestId: pending.requestId,
          revision: pending.revision,
          acknowledged: true,
          changed: true,
        });
        expect(fs.readFileSync(sandbox.globalConfig, 'utf8')).toBe(configs.global);
        expect(fs.readFileSync(sandbox.localConfig, 'utf8')).toBe(configs.local);
        expect(existsSync(tmuxLog)).toBe(false);
      })
  );

  it(
    'acknowledges all without a prior list, then exposes a later accepted final as unread',
    { timeout: 15_000 },
    async () =>
      withSandbox(async (sandbox) => {
        const tmuxLog = await calibratedTmuxGuard(sandbox);
        const seeded = seedExchange(sandbox, 'Alice', 'req_exchange_late_final');
        const acknowledged = await runCli(sandbox, [
          'x',
          'ackall',
          '--identity',
          'alice',
          '--json',
        ]);
        expectJsonSuccess(acknowledged, {
          identity: { id: expect.any(String), name: 'Alice', canonicalName: 'alice' },
          acknowledgedThrough: seeded.revision,
        });
        submitFinal(sandbox, seeded, 'late final reopens attention');
        const reopened = await runCli(sandbox, ['x', 'list', '--identity', 'alice', '--json']);
        expect(reopened.status).toBe(0);
        const document = parseWholeStdout(reopened) as { items: Array<Record<string, unknown>> };
        expect(document.items).toEqual([
          expect.objectContaining({
            requestId: seeded.requestId,
            acknowledged: false,
            final: expect.objectContaining({
              status: 'retained',
              bodyBytes: Buffer.byteLength('late final reopens attention'),
            }),
          }),
        ]);
        expect(existsSync(tmuxLog)).toBe(false);
      })
  );

  it(
    'rejects grammar and numeric failures before creating a database row',
    { timeout: 15_000 },
    async () =>
      withSandbox(async (sandbox) => {
        const invalid = [
          ['x', 'show', 'req_x', 'extra', '--json'],
          ['x', 'ack', 'req_x', '--all', '--revision', '1', '--json'],
          ['x', 'ackall', '--limit', '2', '--json'],
          ['x', 'list', '--limit', '0', '--json'],
          ['x', 'list', '--limit', '201', '--json'],
          ['x', 'list', '--after', '-1', '--json'],
          ['x', 'ack', 'req_x', '--revision', '0', '--json'],
        ];
        for (const args of invalid) {
          const result = await runCli(sandbox, args);
          expect(result.status, args.join(' ')).toBe(1);
          expect(result.stderr, args.join(' ')).toBe('');
          expectError(result, 'USAGE_ERROR');
          expect(existsSync(sandbox.database), args.join(' ')).toBe(false);
        }
      })
  );

  it('keeps identity ownership and revision conflicts distinct', { timeout: 15_000 }, async () =>
    withSandbox(async (sandbox) => {
      const first = seedExchange(sandbox, 'Alice', 'req_exchange_owner', { final: 'first final' });
      seedExchange(sandbox, 'Bob', 'req_exchange_other');
      const stale = await runCli(sandbox, [
        'x',
        'ack',
        first.requestId,
        '--identity',
        'alice',
        '--revision',
        String(first.revision - 1),
        '--json',
      ]);
      expect(stale.status).toBe(5);
      expectError(stale, 'X_REVISION_CONFLICT');

      const wrongOwner = await runCli(sandbox, [
        'x',
        'show',
        first.requestId,
        '--identity',
        'bob',
        '--json',
      ]);
      expect(wrongOwner.status).toBe(3);
      expectError(wrongOwner, 'X_NOT_FOUND');
      const stillUnread = await runCli(sandbox, ['x', 'list', '--identity', 'alice', '--json']);
      expect(stillUnread.status).toBe(0);
      expect(parseWholeStdout(stillUnread)).toEqual(
        expect.objectContaining({
          items: [expect.objectContaining({ requestId: first.requestId, acknowledged: false })],
        })
      );
    })
  );

  it(
    'paginates by revision without skipping or repeating exchange summaries',
    { timeout: 15_000 },
    async () =>
      withSandbox(async (sandbox) => {
        const tmuxLog = await calibratedTmuxGuard(sandbox);
        const seeded = [
          seedExchange(sandbox, 'Alice', 'req_exchange_page_1'),
          seedExchange(sandbox, 'Alice', 'req_exchange_page_2'),
          seedExchange(sandbox, 'Alice', 'req_exchange_page_3'),
        ];
        const first = await runCli(sandbox, [
          'x',
          'list',
          '--identity',
          'alice',
          '--limit',
          '2',
          '--json',
        ]);
        expect(first.status).toBe(0);
        const firstDocument = parseWholeStdout(first) as {
          items: Array<{ requestId: string; revision: number }>;
          nextAfter: number | null;
        };
        expect(firstDocument.items).toHaveLength(2);
        expect(firstDocument.nextAfter).toBe(firstDocument.items[1]!.revision);
        const second = await runCli(sandbox, [
          'x',
          'list',
          '--identity',
          'alice',
          '--limit',
          '2',
          '--after',
          String(firstDocument.nextAfter),
          '--json',
        ]);
        expect(second.status).toBe(0);
        const secondDocument = parseWholeStdout(second) as {
          items: Array<{ requestId: string; revision: number }>;
          nextAfter: number | null;
        };
        expect(secondDocument.items).toHaveLength(1);
        expect(secondDocument.nextAfter).toBeNull();
        expect(
          new Set([...firstDocument.items, ...secondDocument.items].map((item) => item.requestId))
        ).toEqual(new Set(seeded.map((item) => item.requestId)));
        expect(existsSync(tmuxLog)).toBe(false);
      })
  );

  it(
    'requires a verified implicit caller while explicit offline access remains storage-only',
    { timeout: 15_000 },
    async () =>
      withSandbox(async (sandbox) => {
        const seeded = seedExchange(sandbox, 'Alice', 'req_exchange_implicit');
        const tmuxLog = await calibratedTmuxGuard(sandbox);
        // Fix process visibility independently of the host sandbox: the CLI's
        // PID has no parent, and the guarded server cannot supply a pane.
        const psPath = path.join(sandbox.root, 'forbidden-bin', 'ps');
        writeFileSync(psPath, '#!/bin/sh\nprintf "%s 0\\n" "$4"\n');
        chmodSync(psPath, 0o755);
        const implicit = await runCli(sandbox, ['x', 'list', '--json']);
        expect(implicit.status).toBe(1);
        expectError(implicit, 'IDENTITY_REQUIRED');
        // Implicit selection may discover, but must never mutate tmux or
        // proceed without evidence. Reset the calibrated guard for explicit
        // storage-only operations, which must make zero tmux invocations.
        expect(fs.readFileSync(tmuxLog, 'utf8')).toMatch(/^list-panes -a -F [^\n]+\n$/);
        fs.rmSync(tmuxLog);
        const missing = await runCli(sandbox, ['x', 'list', '--identity', 'missing', '--json']);
        expect(missing.status).toBe(3);
        expectError(missing, 'NAME_NOT_FOUND');
        expect(existsSync(tmuxLog)).toBe(false);
        const explicit = await runCli(sandbox, [
          'x',
          'show',
          seeded.requestId,
          '--identity',
          'alice',
          '--json',
        ]);
        expect(explicit.status).toBe(0);
        expect(explicit.stderr).toBe('');
        expect(parseWholeStdout(explicit)).toEqual(
          expect.objectContaining({
            identity: { id: seeded.identityId, name: 'Alice', canonicalName: 'alice' },
          })
        );
        expect(existsSync(tmuxLog)).toBe(false);
      })
  );
});
