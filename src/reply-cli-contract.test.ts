import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createRequestService } from './request-service.js';
import { encodeReplyReceipt } from './reply-receipt.js';
import { MAX_RESPONSE_BYTES } from './domain/response.js';
import { openIdentityRepository } from './storage/identity-repository.js';
import {
  expectError,
  parseWholeStdout,
  runCli,
  withSandbox,
  type Sandbox,
} from './test-support/cli-process.js';

const endpoint = {
  serverId: 'server-1',
  socketPath: '/tmp/tmt.sock',
  serverPid: 1234,
  serverStartTime: 'start',
  paneId: '%1',
  panePid: 5678,
} as const;

interface SeededReply {
  readonly requestId: string;
  readonly attemptId: string;
  readonly receipt: string;
}

interface SeedOptions {
  readonly wait?: boolean;
  readonly releaseWait?: boolean;
  readonly settle?: boolean;
  readonly expired?: boolean;
  readonly preparedAtMs?: number;
  readonly reservePreamble?: boolean;
}

function seedAttempt(sandbox: Sandbox, requestId: string, options: SeedOptions = {}): SeededReply {
  const repository = openIdentityRepository(sandbox.database);
  try {
    const identityName = `identity-${requestId}`;
    const identity = options.reservePreamble
      ? repository.createIdentity(identityName, identityName)
      : undefined;
    const now =
      options.preparedAtMs ?? (options.expired ? Date.now() - 2 * 60 * 60 * 1000 : Date.now());
    const service = createRequestService({ repository, now: () => now });
    const prepared = service.prepare({
      requestId,
      endpoint,
      wait: options.wait ?? false,
      expiresAtMs: options.expired ? now + 1 : now + 60 * 60 * 1000,
      ...(identity && { preamble: { identityId: identity.id, every: 3 } }),
    });
    if (options.settle !== false) {
      service.beginSend(prepared.attemptId);
      service.settle(prepared.attemptId, 'sent');
      if (options.releaseWait) service.releaseWait(prepared.attemptId);
    }
    return {
      requestId,
      attemptId: prepared.attemptId,
      receipt: encodeReplyReceipt({
        version: 1,
        requestId,
        attemptId: prepared.attemptId,
        endpoint,
      }),
    };
  } finally {
    repository.close();
  }
}

function stateSnapshot(sandbox: Sandbox, requestId: string): unknown {
  const database = new Database(sandbox.database, { readonly: true });
  try {
    return {
      attempt: database
        .prepare('SELECT * FROM request_attempts WHERE request_id = ?')
        .get(requestId),
      response: database
        .prepare('SELECT * FROM request_responses WHERE request_id = ?')
        .get(requestId),
      cadence: database.prepare('SELECT * FROM preamble_counters ORDER BY identity_id').all(),
    };
  } finally {
    database.close();
  }
}

function temporaryFile(sandbox: Sandbox, name: string, bytes: string | Uint8Array): string {
  const file = path.join(sandbox.root, name);
  fs.writeFileSync(file, bytes);
  return file;
}

describe('real reply/result CLI process contract', () => {
  it(
    'submits the exact file body and retrieves the exact result after process restart',
    { timeout: 15_000 },
    () =>
      withSandbox(async (sandbox) => {
        const seeded = seedAttempt(sandbox, 'request-exact', { reservePreamble: true });
        const body = '\ufefffirst\r\n\u0000日本語 😀\r\nRESPONSE-END-fake\n';
        const file = temporaryFile(sandbox, 'exact.txt', Buffer.from(body, 'utf8'));
        try {
          const submitted = await runCli(
            sandbox,
            ['reply', seeded.requestId, '--receipt', seeded.receipt, '--file', file, '--json'],
            { outputLimitBytes: 2 * 1024 * 1024 }
          );
          expect(submitted.status).toBe(0);
          expect(parseWholeStdout(submitted)).toMatchObject({
            status: 'submitted',
            requestId: seeded.requestId,
            bodyBytes: Buffer.byteLength(body),
            submittedAtMs: expect.any(Number),
          });
          expect(submitted.stdout).not.toContain(seeded.receipt);
          expect(submitted.stdout).not.toContain(endpoint.socketPath);

          const result = await runCli(sandbox, ['result', seeded.requestId, '--json']);
          expect(result.status).toBe(0);
          expect(parseWholeStdout(result)).toEqual({
            status: 'completed',
            requestId: seeded.requestId,
            response: body,
            bodyBytes: Buffer.byteLength(body),
            submittedAtMs: (parseWholeStdout(submitted) as { submittedAtMs: number }).submittedAtMs,
          });
          expect(result.stdout).not.toContain(seeded.receipt);
          expect(result.stdout).not.toContain(endpoint.socketPath);
        } finally {
          fs.rmSync(file, { force: true });
        }
      })
  );

  it(
    'keeps identical retries idempotent and conflicting replies unchanged',
    { timeout: 15_000 },
    () =>
      withSandbox(async (sandbox) => {
        const seeded = seedAttempt(sandbox, 'request-idempotent', { reservePreamble: true });
        const original = temporaryFile(sandbox, 'original.txt', 'original\r\n日本語');
        const conflict = temporaryFile(sandbox, 'conflict.txt', 'different');
        try {
          const first = await runCli(sandbox, [
            'reply',
            seeded.requestId,
            '--receipt',
            seeded.receipt,
            '--file',
            original,
            '--json',
          ]);
          expect(first.status).toBe(0);
          const firstDocument = parseWholeStdout(first) as { submittedAtMs: number };
          expect(firstDocument).toMatchObject({ status: 'submitted', requestId: seeded.requestId });
          const second = await runCli(sandbox, [
            'reply',
            seeded.requestId,
            '--receipt',
            seeded.receipt,
            '--file',
            original,
            '--json',
          ]);
          expect(second.status).toBe(0);
          expect(parseWholeStdout(second)).toMatchObject({
            submittedAtMs: firstDocument.submittedAtMs,
          });
          const beforeConflict = stateSnapshot(sandbox, seeded.requestId);

          const rejected = await runCli(sandbox, [
            'reply',
            seeded.requestId,
            '--receipt',
            seeded.receipt,
            '--file',
            conflict,
            '--json',
          ]);
          expect(rejected.status).toBe(5);
          expectError(rejected, 'RESPONSE_CONFLICT');
          expect(stateSnapshot(sandbox, seeded.requestId)).toEqual(beforeConflict);
          const result = await runCli(sandbox, ['result', seeded.requestId, '--json']);
          expect(parseWholeStdout(result)).toMatchObject({
            status: 'completed',
            response: 'original\r\n日本語',
            submittedAtMs: firstDocument.submittedAtMs,
          });
        } finally {
          fs.rmSync(original, { force: true });
          fs.rmSync(conflict, { force: true });
        }
      })
  );

  it(
    'accepts an exact 1 MiB stdin body and returns it without truncation',
    { timeout: 20_000 },
    () =>
      withSandbox(async (sandbox) => {
        const seeded = seedAttempt(sandbox, 'request-exact-stdin', { reservePreamble: true });
        const body = 'a'.repeat(MAX_RESPONSE_BYTES);
        const submitted = await runCli(
          sandbox,
          ['reply', seeded.requestId, '--receipt', seeded.receipt, '--stdin', '--json'],
          { stdin: Buffer.from(body, 'utf8'), outputLimitBytes: 3 * 1024 * 1024 }
        );
        expect(submitted.status).toBe(0);
        expect(parseWholeStdout(submitted)).toMatchObject({
          status: 'submitted',
          requestId: seeded.requestId,
          bodyBytes: MAX_RESPONSE_BYTES,
        });
        const result = await runCli(sandbox, ['result', seeded.requestId, '--json'], {
          outputLimitBytes: 3 * 1024 * 1024,
        });
        const document = parseWholeStdout(result) as {
          status: string;
          response: string;
          bodyBytes: number;
        };
        expect(document.status).toBe('completed');
        expect(document.bodyBytes).toBe(MAX_RESPONSE_BYTES);
        expect(document.response).toBe(body);
      })
  );

  it(
    'rejects malformed and oversized files without changing durable request state',
    { timeout: 15_000 },
    () =>
      withSandbox(async (sandbox) => {
        const seeded = seedAttempt(sandbox, 'request-invalid-file', { reservePreamble: true });
        const before = stateSnapshot(sandbox, seeded.requestId);
        const invalidReceipt = await runCli(sandbox, [
          'reply',
          seeded.requestId,
          '--receipt',
          'not-a-receipt',
          '--file',
          path.join(sandbox.root, 'missing.txt'),
          '--json',
        ]);
        expect(invalidReceipt.status).toBe(1);
        expectError(invalidReceipt, 'RESPONSE_RECEIPT_INVALID');
        expect(stateSnapshot(sandbox, seeded.requestId)).toEqual(before);

        const malformed = temporaryFile(sandbox, 'malformed.txt', Buffer.from([0xc3, 0x28]));
        const oversized = temporaryFile(
          sandbox,
          'oversized.txt',
          Buffer.concat([Buffer.alloc(1024 * 1024, 0x61), Buffer.from('x')])
        );
        try {
          const invalid = await runCli(sandbox, [
            'reply',
            seeded.requestId,
            '--receipt',
            seeded.receipt,
            '--file',
            malformed,
            '--json',
          ]);
          expect(invalid.status).toBe(1);
          expectError(invalid, 'RESPONSE_INPUT_INVALID');
          expect(stateSnapshot(sandbox, seeded.requestId)).toEqual(before);

          const tooLarge = await runCli(sandbox, [
            'reply',
            seeded.requestId,
            '--receipt',
            seeded.receipt,
            '--file',
            oversized,
            '--json',
          ]);
          expect(tooLarge.status).toBe(1);
          expectError(tooLarge, 'RESPONSE_INPUT_TOO_LARGE');
          expect(stateSnapshot(sandbox, seeded.requestId)).toEqual(before);
        } finally {
          fs.rmSync(malformed, { force: true });
          fs.rmSync(oversized, { force: true });
        }
      })
  );

  it(
    'checks every recorded endpoint fence and rejects wrong request/attempt receipts',
    { timeout: 20_000 },
    () =>
      withSandbox(async (sandbox) => {
        const seeded = seedAttempt(sandbox, 'request-fences', { reservePreamble: true });
        const empty = temporaryFile(sandbox, 'empty-fence.txt', '');
        const before = stateSnapshot(sandbox, seeded.requestId);
        const mismatchedRequest = encodeReplyReceipt({
          version: 1,
          requestId: 'other-request',
          attemptId: seeded.attemptId,
          endpoint,
        });
        const requestResult = await runCli(sandbox, [
          'reply',
          seeded.requestId,
          '--receipt',
          mismatchedRequest,
          '--file',
          empty,
          '--json',
        ]);
        expect(requestResult.status).toBe(1);
        expectError(requestResult, 'RESPONSE_RECEIPT_MISMATCH');
        expect(stateSnapshot(sandbox, seeded.requestId)).toEqual(before);

        const mismatchedAttempt = encodeReplyReceipt({
          version: 1,
          requestId: seeded.requestId,
          attemptId: 'other-attempt',
          endpoint,
        });
        const attemptResult = await runCli(sandbox, [
          'reply',
          seeded.requestId,
          '--receipt',
          mismatchedAttempt,
          '--file',
          empty,
          '--json',
        ]);
        expect(attemptResult.status).toBe(1);
        expectError(attemptResult, 'RESPONSE_ATTEMPT_MISMATCH');
        expect(stateSnapshot(sandbox, seeded.requestId)).toEqual(before);

        const fields = [
          ['serverId', { serverId: 'other-server' }],
          ['socketPath', { socketPath: '/tmp/other.sock' }],
          ['serverPid', { serverPid: 1235 }],
          ['serverStartTime', { serverStartTime: 'other-start' }],
          ['paneId', { paneId: '%2' }],
          ['panePid', { panePid: 5679 }],
        ] as const;
        for (const [field, change] of fields) {
          const wrongEndpoint = encodeReplyReceipt({
            version: 1,
            requestId: seeded.requestId,
            attemptId: seeded.attemptId,
            endpoint: { ...endpoint, ...change },
          });
          const result = await runCli(sandbox, [
            'reply',
            seeded.requestId,
            '--receipt',
            wrongEndpoint,
            '--file',
            empty,
            '--json',
          ]);
          expect(result.status, field).toBe(1);
          expectError(result, 'RESPONSE_RECIPIENT_MISMATCH');
          expect(stateSnapshot(sandbox, seeded.requestId)).toEqual(before);
        }
      })
  );

  it(
    'rejects malformed and oversized stdin at EOF while preserving state',
    { timeout: 15_000 },
    () =>
      withSandbox(async (sandbox) => {
        const seeded = seedAttempt(sandbox, 'request-invalid-stdin', { reservePreamble: true });
        const before = stateSnapshot(sandbox, seeded.requestId);
        for (const [name, input, code] of [
          ['malformed', Buffer.from([0xc3, 0x28]), 'RESPONSE_INPUT_INVALID'],
          [
            'oversized',
            Buffer.concat([Buffer.alloc(1024 * 1024, 0x61), Buffer.from('x')]),
            'RESPONSE_INPUT_TOO_LARGE',
          ],
        ] as const) {
          const result = await runCli(
            sandbox,
            ['reply', seeded.requestId, '--receipt', seeded.receipt, '--stdin', '--json'],
            { stdin: input, outputLimitBytes: 2 * 1024 * 1024 }
          );
          expect(result.status, name).toBe(1);
          expectError(result, code);
          expect(stateSnapshot(sandbox, seeded.requestId)).toEqual(before);
        }
      })
  );

  it('returns one unavailable result without tmux for unknown requests', { timeout: 10_000 }, () =>
    withSandbox(async (sandbox) => {
      const result = await runCli(sandbox, ['result', 'unknown-request', '--json']);
      expect(result.status).toBe(3);
      expect(result.stderr).toBe('');
      expectError(result, 'RESPONSE_NOT_AVAILABLE');
    })
  );

  it(
    'returns unavailable for real pending and expired attempts, and rejects an unknown valid receipt',
    { timeout: 20_000 },
    () =>
      withSandbox(async (sandbox) => {
        const pending = seedAttempt(sandbox, 'request-pending', {
          settle: false,
          reservePreamble: true,
        });
        const expired = seedAttempt(sandbox, 'request-expired', {
          settle: false,
          expired: true,
          reservePreamble: true,
        });
        for (const requestId of [pending.requestId, expired.requestId]) {
          const result = await runCli(sandbox, ['result', requestId, '--json']);
          expect(result.status).toBe(3);
          expectError(result, 'RESPONSE_NOT_AVAILABLE');
        }

        const unknownId = 'request-unknown-valid-receipt';
        const unknownReceipt = encodeReplyReceipt({
          version: 1,
          requestId: unknownId,
          attemptId: 'attempt-unknown',
          endpoint,
        });
        const empty = temporaryFile(sandbox, 'empty-unknown.txt', '');
        const reply = await runCli(sandbox, [
          'reply',
          unknownId,
          '--receipt',
          unknownReceipt,
          '--file',
          empty,
          '--json',
        ]);
        expect(reply.status).toBe(3);
        expectError(reply, 'RESPONSE_REQUEST_NOT_FOUND');
        expect(reply.stdout).not.toContain(unknownReceipt);
      })
  );

  it(
    'hides an actually expired retained body and rejects resurrection through the public reply command',
    { timeout: 15_000 },
    () =>
      withSandbox(async (sandbox) => {
        const preparedAtMs = Date.now() - 8 * 24 * 60 * 60 * 1000;
        const seeded = seedAttempt(sandbox, 'request-expired-body', {
          preparedAtMs,
          reservePreamble: true,
        });
        const repository = openIdentityRepository(sandbox.database);
        try {
          const service = createRequestService({ repository, now: () => preparedAtMs + 1 });
          service.submitResponse({
            requestId: seeded.requestId,
            attemptId: seeded.attemptId,
            endpoint,
            body: 'retained but expired',
          });
        } finally {
          repository.close();
        }
        const before = stateSnapshot(sandbox, seeded.requestId);
        const result = await runCli(sandbox, ['result', seeded.requestId, '--json']);
        expect(result.status).toBe(3);
        expectError(result, 'RESPONSE_NOT_AVAILABLE');
        expect(result.stdout).not.toContain('retained but expired');
        const retry = await runCli(
          sandbox,
          ['reply', seeded.requestId, '--receipt', seeded.receipt, '--stdin', '--json'],
          { stdin: Buffer.from('retained but expired') }
        );
        expect(retry.status).toBe(1);
        expectError(retry, 'RESPONSE_EXPIRED');
        expect(stateSnapshot(sandbox, seeded.requestId)).toEqual(before);
      })
  );

  it(
    'accepts a late reply after waiter release without a live tmux pane',
    { timeout: 15_000 },
    () =>
      withSandbox(async (sandbox) => {
        const seeded = seedAttempt(sandbox, 'request-late', {
          wait: true,
          releaseWait: true,
          reservePreamble: true,
        });
        const empty = temporaryFile(sandbox, 'empty-late.txt', '');
        const reply = await runCli(sandbox, [
          'reply',
          seeded.requestId,
          '--receipt',
          seeded.receipt,
          '--file',
          empty,
          '--json',
        ]);
        expect(reply.status).toBe(0);
        expect(parseWholeStdout(reply)).toMatchObject({ status: 'submitted', bodyBytes: 0 });
        const result = await runCli(sandbox, ['result', seeded.requestId, '--json']);
        expect(parseWholeStdout(result)).toMatchObject({
          status: 'completed',
          response: '',
          bodyBytes: 0,
        });
      })
  );

  it(
    'rejects malformed positional IDs before touching an existing request',
    { timeout: 10_000 },
    () =>
      withSandbox(async (sandbox) => {
        const seeded = seedAttempt(sandbox, 'request-valid', { reservePreamble: true });
        const before = stateSnapshot(sandbox, seeded.requestId);
        const result = await runCli(sandbox, ['result', 'x'.repeat(257), '--json']);
        expect(result.status).toBe(1);
        expectError(result, 'USAGE_ERROR');
        expect(stateSnapshot(sandbox, seeded.requestId)).toEqual(before);
      })
  );

  it(
    'maps an open stdin past the five-second input deadline and leaves state untouched',
    { timeout: 15_000 },
    () =>
      withSandbox(async (sandbox) => {
        const seeded = seedAttempt(sandbox, 'request-stdin-timeout', { reservePreamble: true });
        const before = stateSnapshot(sandbox, seeded.requestId);
        const result = await runCli(
          sandbox,
          ['reply', seeded.requestId, '--receipt', seeded.receipt, '--stdin', '--json'],
          { stdin: Buffer.from('partial'), closeStdin: false, deadlineMs: 8_000 }
        );
        expect(result.status).toBe(4);
        expectError(result, 'RESPONSE_INPUT_TIMEOUT');
        expect(stateSnapshot(sandbox, seeded.requestId)).toEqual(before);
      })
  );
});
