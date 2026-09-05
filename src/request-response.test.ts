import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRequestService,
  type RequestEndpoint,
  type RequestResponseSubmission,
  type RequestService,
} from './request-service.js';
import { openIdentityRepository, type IdentityRepository } from './storage/identity-repository.js';

const MAX_BODY_BYTES = 1_048_576;
const RESPONSE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const directories: string[] = [];
const repositories: IdentityRepository[] = [];

const endpoint: RequestEndpoint = {
  serverId: 'server-1',
  socketPath: '/tmp/tmt-server-1',
  serverPid: 41,
  serverStartTime: 'server-start-1',
  paneId: '%7',
  panePid: 99,
};

interface Fixture {
  readonly database: string;
  readonly endpoint: RequestEndpoint;
  readonly identityId: string;
  readonly repository: IdentityRepository;
  readonly service: RequestService;
  readonly clock: { value: number };
}

function fixture(): Fixture {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-response-'));
  directories.push(directory);
  const database = path.join(directory, 'tmux-team.db');
  const repository = openIdentityRepository(database);
  repositories.push(repository);
  const identity = repository.createIdentity('Alice', 'alice');
  const clock = { value: 1_700_000_000_000 };
  const service = createRequestService({ repository, now: () => clock.value });
  return {
    database,
    endpoint,
    identityId: identity.id,
    repository,
    service,
    clock,
  };
}

function prepare(
  value: Fixture,
  requestId: string,
  options: {
    endpoint?: RequestEndpoint;
    expiresAtMs?: number;
    wait?: boolean;
    preamble?: { identityId: string; every: number };
  } = {}
): string {
  return value.service.prepare({
    requestId,
    endpoint: options.endpoint ?? value.endpoint,
    wait: options.wait ?? true,
    expiresAtMs: options.expiresAtMs ?? value.clock.value + 60 * 60 * 1000,
    ...(options.preamble && { preamble: options.preamble }),
  }).attemptId;
}

function prepareSending(
  value: Fixture,
  requestId: string,
  options: Parameters<typeof prepare>[2] = {}
): string {
  const attemptId = prepare(value, requestId, options);
  value.service.beginSend(attemptId);
  return attemptId;
}

function expectResponseError(action: () => unknown, code: string): void {
  let thrown = false;
  try {
    action();
  } catch (error) {
    thrown = true;
    expect(error).toMatchObject({ code });
  }
  expect(thrown).toBe(true);
}

function submit(
  value: Fixture,
  requestId: string,
  attemptId: string,
  body: string,
  target = value.endpoint
) {
  return value.service.submitResponse({
    requestId,
    attemptId,
    endpoint: target,
    body,
  });
}

function stateSnapshot(value: Fixture, requestIds: readonly string[]) {
  return {
    attempts: value.service.listAttempts(),
    cadence: value.repository.getPreambleCount(value.identityId),
    responses: requestIds.map(
      (requestId) => [requestId, value.service.getResponse(requestId)] as const
    ),
  };
}

function invalidSubmission(value: Fixture, input: unknown): void {
  value.service.submitResponse(input as RequestResponseSubmission);
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('durable request responses', () => {
  it('preserves every valid body byte-for-byte, including empty, control, marker-like, and Unicode text', () => {
    const value = fixture();
    const bodies = [
      '',
      '  \t  ',
      '\uFEFF',
      '\u0000',
      'line one\r\nline two\r\n',
      'RESPONSE-END-abc\n```\nmarker-like text\n```',
      '日本語、café、🙂\u0301',
    ];

    for (const [index, body] of bodies.entries()) {
      const requestId = `request-body-${index}`;
      const attemptId = prepareSending(value, requestId);
      const submitted = submit(value, requestId, attemptId, body);
      expect(submitted).toEqual({
        requestId,
        attemptId,
        endpoint: value.endpoint,
        body,
        bodyBytes: Buffer.byteLength(body, 'utf8'),
        submittedAtMs: value.clock.value,
      });
      expect(value.service.getResponse(requestId)).toEqual(submitted);
    }
  });

  it('accepts exactly one mebibyte in ASCII and four-byte Unicode bodies', () => {
    const value = fixture();
    const bodies = ['a'.repeat(MAX_BODY_BYTES), '🙂'.repeat(MAX_BODY_BYTES / 4)];

    for (const [index, body] of bodies.entries()) {
      expect(Buffer.byteLength(body, 'utf8')).toBe(MAX_BODY_BYTES);
      const requestId = `request-boundary-${index}`;
      const attemptId = prepareSending(value, requestId);
      const submitted = submit(value, requestId, attemptId, body);
      expect(submitted.bodyBytes).toBe(MAX_BODY_BYTES);
      expect(value.service.getResponse(requestId)).toEqual(submitted);
    }
  });

  it('rejects non-string, lone-surrogate, and oversize bodies without creating a response', () => {
    const value = fixture();
    const invalidBodies = [null, 42, {}, '\uD800', '\uDC00'] as unknown[];
    for (const [index, body] of invalidBodies.entries()) {
      const requestId = `request-invalid-${index}`;
      const attemptId = prepareSending(value, requestId);
      const before = stateSnapshot(value, [requestId]);
      expectResponseError(
        () => submit(value, requestId, attemptId, body as string),
        'RESPONSE_INPUT_INVALID'
      );
      expect(stateSnapshot(value, [requestId])).toEqual(before);
    }

    const requestId = 'request-too-large';
    const attemptId = prepareSending(value, requestId);
    const before = stateSnapshot(value, [requestId]);
    expectResponseError(
      () => submit(value, requestId, attemptId, 'a'.repeat(MAX_BODY_BYTES + 1)),
      'RESPONSE_INPUT_TOO_LARGE'
    );
    expectResponseError(
      () => submit(value, requestId, attemptId, 'a'.repeat(MAX_BODY_BYTES - 3) + '🙂'),
      'RESPONSE_INPUT_TOO_LARGE'
    );
    expect(stateSnapshot(value, [requestId])).toEqual(before);
  });

  it('rejects malformed submission envelopes, endpoint fields, IDs, and invalid response lookups atomically', () => {
    const value = fixture();
    const requestId = 'request-input-envelope';
    const attemptId = prepareSending(value, requestId, {
      preamble: { identityId: value.identityId, every: 3 },
    });
    const before = stateSnapshot(value, [requestId]);
    const malformed = [
      null,
      42,
      {},
      { requestId, attemptId, endpoint: value.endpoint },
      { requestId, attemptId, endpoint: { ...value.endpoint, serverId: '' }, body: 'body' },
      { requestId, attemptId, endpoint: { ...value.endpoint, socketPath: 7 }, body: 'body' },
      { requestId, attemptId, endpoint: { ...value.endpoint, serverPid: 0 }, body: 'body' },
      { requestId, attemptId, endpoint: { ...value.endpoint, panePid: Number.NaN }, body: 'body' },
      { requestId: '', attemptId, endpoint: value.endpoint, body: 'body' },
      { requestId, attemptId: '', endpoint: value.endpoint, body: 'body' },
    ];
    for (const input of malformed) {
      expectResponseError(() => invalidSubmission(value, input), 'RESPONSE_INPUT_INVALID');
      expect(stateSnapshot(value, [requestId])).toEqual(before);
    }
    expectResponseError(() => value.service.getResponse(''), 'RESPONSE_INPUT_INVALID');
    expectResponseError(
      () => value.service.getResponse(null as unknown as string),
      'RESPONSE_INPUT_INVALID'
    );
  });

  it('rejects preparation when either minimum expiry or response deadline would overflow', () => {
    const value = fixture();
    const before = stateSnapshot(value, []);
    for (const remainingMs of [1_000, DAY_MS]) {
      value.clock.value = Number.MAX_SAFE_INTEGER - remainingMs;
      expect(() =>
        value.service.prepare({
          requestId: 'request-time-overflow',
          endpoint: value.endpoint,
          wait: true,
          expiresAtMs: Number.MAX_SAFE_INTEGER,
          preamble: { identityId: value.identityId, every: 3 },
        })
      ).toThrow();
      expect(stateSnapshot(value, [])).toEqual(before);
    }
  });

  it('uses request, attempt, and all endpoint fields as an explicit response fence', () => {
    const value = fixture();
    const requestId = 'request-fence';
    const attemptId = prepareSending(value, requestId);
    const otherAttemptId = prepare(value, 'other-request');
    const before = stateSnapshot(value, [requestId, 'other-request']);
    expectResponseError(
      () => submit(value, 'unknown-request', 'unknown-attempt', 'body'),
      'RESPONSE_REQUEST_NOT_FOUND'
    );
    expectResponseError(
      () => submit(value, requestId, otherAttemptId, 'body'),
      'RESPONSE_ATTEMPT_MISMATCH'
    );

    const endpointVariants: Array<[keyof RequestEndpoint, RequestEndpoint[keyof RequestEndpoint]]> =
      [
        ['serverId', 'other-server'],
        ['socketPath', '/tmp/other-server'],
        ['serverPid', endpoint.serverPid + 1],
        ['serverStartTime', 'other-start'],
        ['paneId', '%8'],
        ['panePid', endpoint.panePid + 1],
      ];
    for (const [field, replacement] of endpointVariants) {
      const mismatched = { ...value.endpoint, [field]: replacement } as RequestEndpoint;
      expectResponseError(
        () => submit(value, requestId, attemptId, 'body', mismatched),
        'RESPONSE_RECIPIENT_MISMATCH'
      );
      expect(stateSnapshot(value, [requestId, 'other-request'])).toEqual(before);
    }
    expect(value.service.getResponse(requestId)).toBeUndefined();
    expect(stateSnapshot(value, [requestId, 'other-request'])).toEqual(before);
  });

  it('accepts sending, sent, and uncertain attempts, while rejecting prepared and definitely failed ones', () => {
    const value = fixture();

    const sendingAttempt = prepareSending(value, 'request-sending');
    expect(submit(value, 'request-sending', sendingAttempt, 'sending body').body).toBe(
      'sending body'
    );

    const sentAttempt = prepareSending(value, 'request-sent');
    value.service.settle(sentAttempt, 'sent');
    expect(submit(value, 'request-sent', sentAttempt, 'sent body').body).toBe('sent body');

    const uncertainAttempt = prepareSending(value, 'request-uncertain');
    value.service.settle(uncertainAttempt, 'uncertain');
    value.service.releaseWait(uncertainAttempt);
    expect(submit(value, 'request-uncertain', uncertainAttempt, 'uncertain body').body).toBe(
      'uncertain body'
    );

    const preparedAttempt = prepare(value, 'request-prepared');
    const preparedBefore = stateSnapshot(value, ['request-prepared']);
    expectResponseError(
      () => submit(value, 'request-prepared', preparedAttempt, 'prepared body'),
      'RESPONSE_STATE_INVALID'
    );
    expect(stateSnapshot(value, ['request-prepared'])).toEqual(preparedBefore);

    const failedAttempt = prepare(value, 'request-failed', {
      preamble: { identityId: value.identityId, every: 3 },
    });
    value.service.settle(failedAttempt, 'definitely_failed');
    const failedBefore = stateSnapshot(value, ['request-failed']);
    expectResponseError(
      () => submit(value, 'request-failed', failedAttempt, 'failed body'),
      'RESPONSE_STATE_INVALID'
    );
    expect(stateSnapshot(value, ['request-failed'])).toEqual(failedBefore);
    expect(value.repository.getPreambleCount(value.identityId)).toBe(0);
  });

  it('keeps an accepted reply authoritative when a later definitely-failed settlement is attempted', () => {
    const value = fixture();
    const attemptId = prepareSending(value, 'request-reply-first', {
      preamble: { identityId: value.identityId, every: 3 },
    });
    const accepted = submit(value, 'request-reply-first', attemptId, 'authoritative body');

    value.service.settle(attemptId, 'definitely_failed');
    value.service.settle(attemptId, 'definitely_failed');
    expect(value.service.getAttempt(attemptId)).toMatchObject({
      status: 'uncertain',
      cadenceReserved: true,
    });
    expect(value.repository.getPreambleCount(value.identityId)).toBe(1);
    expect(value.service.getResponse('request-reply-first')).toEqual(accepted);

    const sentAfterReply = prepareSending(value, 'request-sent-after-reply');
    submit(value, 'request-sent-after-reply', sentAfterReply, 'sent after reply');
    value.service.settle(sentAfterReply, 'sent');
    expect(value.service.getAttempt(sentAfterReply)?.status).toBe('sent');

    const uncertainAfterReply = prepareSending(value, 'request-uncertain-after-reply');
    submit(value, 'request-uncertain-after-reply', uncertainAfterReply, 'uncertain after reply');
    value.service.settle(uncertainAfterReply, 'uncertain');
    expect(value.service.getAttempt(uncertainAfterReply)?.status).toBe('uncertain');
  });

  it('allows a late reply at attempt expiry but rejects it at the seven-day response deadline', () => {
    const value = fixture();
    const requestId = 'request-deadline';
    const attemptId = prepareSending(value, requestId);
    const attempt = value.service.getAttempt(attemptId);
    if (!attempt) throw new Error('Expected prepared attempt.');

    value.clock.value = attempt.expiresAtMs;
    expect(submit(value, requestId, attemptId, 'late but valid').body).toBe('late but valid');

    const nearDeadlineId = 'request-deadline-minus-one';
    const nearDeadlineAttemptId = prepareSending(value, nearDeadlineId);
    const nearDeadlineAttempt = value.service.getAttempt(nearDeadlineAttemptId);
    if (!nearDeadlineAttempt) throw new Error('Expected near-deadline attempt.');
    value.clock.value = nearDeadlineAttempt.preparedAtMs + RESPONSE_RETENTION_MS - 1;
    const nearDeadlineResponse = submit(
      value,
      nearDeadlineId,
      nearDeadlineAttemptId,
      'one millisecond early'
    );
    expect(value.service.getResponse(nearDeadlineId)).toEqual(nearDeadlineResponse);

    const extendedId = 'request-extended-expiry';
    const extendedExpiry = value.clock.value + 20 * DAY_MS;
    const extendedAttemptId = prepareSending(value, extendedId, {
      expiresAtMs: extendedExpiry,
    });
    const extendedAttempt = value.service.getAttempt(extendedAttemptId);
    if (!extendedAttempt) throw new Error('Expected extended-expiry attempt.');
    value.clock.value = extendedExpiry - 1;
    const extendedResponse = submit(value, extendedId, extendedAttemptId, 'before extended expiry');
    expect(value.service.getResponse(extendedId)).toEqual(extendedResponse);

    const exactDeadlineId = 'request-deadline-exact';
    const exactAttemptId = prepareSending(value, exactDeadlineId);
    const exactAttempt = value.service.getAttempt(exactAttemptId);
    if (!exactAttempt) throw new Error('Expected exact-deadline attempt.');
    value.clock.value = exactAttempt.preparedAtMs + RESPONSE_RETENTION_MS;
    expectResponseError(
      () => submit(value, exactDeadlineId, exactAttemptId, 'too late'),
      'RESPONSE_EXPIRED'
    );
    expect(value.service.getResponse(exactDeadlineId)).toBeUndefined();
  });

  it('releases a waiter without changing response eligibility', () => {
    const value = fixture();
    const attemptId = prepareSending(value, 'request-released');
    value.service.releaseWait(attemptId);
    expect(value.service.getAttempt(attemptId)?.waitActive).toBe(false);
    expect(submit(value, 'request-released', attemptId, 'after release').body).toBe(
      'after release'
    );
  });

  it('retains a response while attempt metadata reaches ordinary cleanup age, then expires both at seven days', () => {
    const value = fixture();
    const requestId = 'request-retention';
    const attemptId = prepareSending(value, requestId);
    const accepted = submit(value, requestId, attemptId, 'retained body');
    value.service.settle(attemptId, 'sent');
    value.service.releaseWait(attemptId);

    value.clock.value = accepted.submittedAtMs + DAY_MS + 1;
    value.service.cleanup();
    expect(value.service.getResponse(requestId)).toEqual(accepted);
    expect(submit(value, requestId, attemptId, 'retained body')).toEqual(accepted);
    expect(value.service.getAttempt(attemptId)).toBeDefined();

    value.clock.value = accepted.submittedAtMs + RESPONSE_RETENTION_MS - 1;
    expect(value.service.getResponse(requestId)).toEqual(accepted);
    value.clock.value = accepted.submittedAtMs + RESPONSE_RETENTION_MS;
    expect(value.service.getResponse(requestId)).toBeUndefined();
    const expiredAttempt = value.service.getAttempt(attemptId);
    expectResponseError(
      () => submit(value, requestId, attemptId, 'retained body'),
      'RESPONSE_EXPIRED'
    );
    expect(value.repository.findResponse(requestId)).toEqual(accepted);
    expect(value.service.getAttempt(attemptId)).toEqual(expiredAttempt);
    value.service.cleanup();
    expect(value.service.getResponse(requestId)).toBeUndefined();
    expect(value.repository.findResponse(requestId)).toBeUndefined();
    expect(value.service.getAttempt(attemptId)).toBeUndefined();
  });

  it('preserves the settlement retention floor when cleanup first settles an abandoned send', () => {
    const value = fixture();
    const requestId = 'request-late-cleanup';
    const attemptId = prepareSending(value, requestId, {
      preamble: { identityId: value.identityId, every: 3 },
    });
    value.clock.value += 8 * DAY_MS;
    const settledAtMs = value.clock.value;
    value.service.cleanup();
    expect(value.service.getAttempt(attemptId)).toMatchObject({
      status: 'uncertain',
      waitActive: false,
      settledAtMs,
      cadenceReserved: true,
    });
    value.clock.value = settledAtMs + DAY_MS - 1;
    value.service.cleanup();
    expect(value.service.getAttempt(attemptId)).toBeDefined();
    value.clock.value += 1;
    value.service.cleanup();
    expect(value.service.getAttempt(attemptId)).toBeUndefined();
    expect(value.repository.getPreambleCount(value.identityId)).toBe(1);
  });

  it('does not resurrect a body after early retention when the longer attempt deadline remains open', () => {
    const value = fixture();
    const requestId = 'request-long-expiry';
    const expiresAtMs = value.clock.value + 20 * DAY_MS;
    const attemptId = prepareSending(value, requestId, { expiresAtMs });
    const accepted = submit(value, requestId, attemptId, 'long-expiry body');
    const submittedAtMs = accepted.submittedAtMs;

    value.clock.value = submittedAtMs + RESPONSE_RETENTION_MS;
    value.service.cleanup();
    expect(value.service.getResponse(requestId)).toBeUndefined();
    expect(value.service.getAttempt(attemptId)).toMatchObject({
      status: 'sending',
      expiresAtMs,
    });
    expectResponseError(
      () => submit(value, requestId, attemptId, 'long-expiry body'),
      'RESPONSE_EXPIRED'
    );
    expect(value.service.getResponse(requestId)).toBeUndefined();
  });

  it('keeps the expiry marker and does not refund cadence after body retention cleanup', () => {
    const value = fixture();
    const requestId = 'request-long-expiry-marker';
    const expiresAtMs = value.clock.value + 20 * DAY_MS;
    const attemptId = prepareSending(value, requestId, {
      expiresAtMs,
      preamble: { identityId: value.identityId, every: 3 },
    });
    submit(value, requestId, attemptId, 'marker body');
    value.clock.value += RESPONSE_RETENTION_MS;
    value.service.cleanup();

    expect(value.service.getResponse(requestId)).toBeUndefined();
    value.service.settle(attemptId, 'definitely_failed');
    expect(value.service.getAttempt(attemptId)).toMatchObject({
      status: 'uncertain',
      cadenceReserved: true,
      expiresAtMs,
    });
    expect(value.repository.getPreambleCount(value.identityId)).toBe(1);
  });

  it('blocks request-id reuse while a retained response outlives its purged attempt metadata', () => {
    const value = fixture();
    const requestId = 'request-retained-id';
    const attemptId = prepareSending(value, requestId, {
      preamble: { identityId: value.identityId, every: 3 },
    });
    value.clock.value += 6 * DAY_MS;
    const accepted = submit(value, requestId, attemptId, 'retained request id');
    value.service.settle(attemptId, 'sent');
    value.service.releaseWait(attemptId);

    value.clock.value = accepted.submittedAtMs + 2 * DAY_MS;
    value.service.cleanup();
    expect(value.service.getAttempt(attemptId)).toBeUndefined();
    expect(value.service.getResponse(requestId)).toEqual(accepted);
    expect(submit(value, requestId, attemptId, 'retained request id')).toEqual(accepted);
    const attemptsBeforeReuse = value.service.listAttempts();
    const cadenceBeforeReuse = value.repository.getPreambleCount(value.identityId);
    expect(() =>
      value.service.prepare({
        requestId,
        endpoint: value.endpoint,
        wait: true,
        expiresAtMs: value.clock.value + 60 * 60 * 1000,
        preamble: { identityId: value.identityId, every: 3 },
      })
    ).toThrow();
    expect(value.service.listAttempts()).toEqual(attemptsBeforeReuse);
    expect(value.repository.getPreambleCount(value.identityId)).toBe(cadenceBeforeReuse);

    value.clock.value = accepted.submittedAtMs + RESPONSE_RETENTION_MS + 1;
    value.service.cleanup();
    expect(value.service.getResponse(requestId)).toBeUndefined();
    expectResponseError(
      () => submit(value, requestId, attemptId, 'retained request id'),
      'RESPONSE_REQUEST_NOT_FOUND'
    );
    const reused = value.service.prepare({
      requestId,
      endpoint: value.endpoint,
      wait: true,
      expiresAtMs: value.clock.value + 60 * 60 * 1000,
      preamble: { identityId: value.identityId, every: 3 },
    });
    expect(reused.attemptId).not.toBe(attemptId);
    expect(value.repository.getPreambleCount(value.identityId)).toBe(cadenceBeforeReuse + 1);
    value.service.beginSend(reused.attemptId);
    const beforeStaleReply = stateSnapshot(value, [requestId]);
    expectResponseError(
      () => submit(value, requestId, attemptId, 'retained request id'),
      'RESPONSE_ATTEMPT_MISMATCH'
    );
    expect(stateSnapshot(value, [requestId])).toEqual(beforeStaleReply);
    const newResponse = submit(value, requestId, reused.attemptId, 'new isolated body');
    expect(newResponse.body).toBe('new isolated body');
    expect(value.service.getResponse(requestId)).toEqual(newResponse);
  });

  it('makes identical retries idempotent after reopening SQLite and preserves the accepted body on conflict', () => {
    const value = fixture();
    const requestId = 'request-reopen';
    const attemptId = prepareSending(value, requestId);
    const accepted = submit(value, requestId, attemptId, 'immutable body');
    value.repository.close();

    const reopened = openIdentityRepository(value.database);
    repositories.push(reopened);
    const reopenedService = createRequestService({
      repository: reopened,
      now: () => value.clock.value,
    });
    const attemptsBeforeRetry = reopenedService.listAttempts();
    const cadenceBeforeRetry = reopened.getPreambleCount(value.identityId);
    expect(
      reopenedService.submitResponse({
        requestId,
        attemptId,
        endpoint: value.endpoint,
        body: 'immutable body',
      })
    ).toEqual(accepted);
    expect(reopenedService.listAttempts()).toEqual(attemptsBeforeRetry);
    expect(reopened.getPreambleCount(value.identityId)).toBe(cadenceBeforeRetry);
    expectResponseError(
      () =>
        reopenedService.submitResponse({
          requestId,
          attemptId,
          endpoint: value.endpoint,
          body: 'conflicting body',
        }),
      'RESPONSE_CONFLICT'
    );
    const wrongAttempt = {
      requestId,
      attemptId: 'stale-attempt',
      endpoint: value.endpoint,
      body: 'immutable body',
    };
    expectResponseError(
      () => reopenedService.submitResponse(wrongAttempt),
      'RESPONSE_ATTEMPT_MISMATCH'
    );
    const mismatchedEndpoints: RequestEndpoint[] = [
      { ...value.endpoint, serverId: 'other-server' },
      { ...value.endpoint, socketPath: '/tmp/other-server' },
      { ...value.endpoint, serverPid: value.endpoint.serverPid + 1 },
      { ...value.endpoint, serverStartTime: 'other-start' },
      { ...value.endpoint, paneId: '%8' },
      { ...value.endpoint, panePid: value.endpoint.panePid + 1 },
    ];
    for (const mismatchedEndpoint of mismatchedEndpoints) {
      expectResponseError(
        () =>
          reopenedService.submitResponse({
            requestId,
            attemptId,
            endpoint: mismatchedEndpoint,
            body: 'immutable body',
          }),
        'RESPONSE_RECIPIENT_MISMATCH'
      );
    }
    expect(reopenedService.listAttempts()).toEqual(attemptsBeforeRetry);
    expect(reopened.getPreambleCount(value.identityId)).toBe(cadenceBeforeRetry);
    expect(reopenedService.getResponse(requestId)).toEqual(accepted);
  });

  it('rolls back an interrupted finalization without changing the attempt or cadence', () => {
    const value = fixture();
    const requestId = 'request-rollback';
    const attemptId = prepareSending(value, requestId, {
      preamble: { identityId: value.identityId, every: 3 },
    });
    const before = value.service.getAttempt(attemptId);
    if (!before) throw new Error('Expected rollback attempt.');
    const failingRepository = {
      ...value.repository,
      withImmediateTransaction<T>(operation: () => T): T {
        return value.repository.withImmediateTransaction(() => {
          operation();
          throw new Error('injected finalization crash');
        });
      },
    };
    const failingService = createRequestService({
      repository: failingRepository,
      now: () => value.clock.value,
    });

    expect(() =>
      failingService.submitResponse({
        requestId,
        attemptId,
        endpoint: value.endpoint,
        body: 'body',
      })
    ).toThrow('injected finalization crash');
    expect(value.service.getResponse(requestId)).toBeUndefined();
    expect(value.service.getAttempt(attemptId)).toEqual(before);
    expect(value.repository.getPreambleCount(value.identityId)).toBe(1);
  });
});
