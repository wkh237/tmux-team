import { afterEach, describe, expect, it } from 'vitest';
import { createRequestService, type RequestEndpoint } from './request-service.js';
import { projectExchangeSummary } from './request-attention.js';
import { openIdentityRepository } from './storage/identity-repository.js';

const endpoint: RequestEndpoint = {
  serverId: 'attention-test-server',
  socketPath: '/tmp/attention-test.sock',
  serverPid: 1001,
  serverStartTime: 'attention-test-start',
  paneId: '%attention-test',
  panePid: 1002,
};

const databases: ReturnType<typeof openIdentityRepository>[] = [];
const now = { value: 10_000 };

function service(retentionDays = 90) {
  const repository = openIdentityRepository(':memory:');
  databases.push(repository);
  return {
    repository,
    service: createRequestService({
      repository,
      now: () => now.value,
      getRetentionDays: () => retentionDays,
    }),
  };
}

function prepare(
  requestService: ReturnType<typeof createRequestService>,
  requestId: string,
  identityId?: string
) {
  return requestService.prepare({
    requestId,
    message: `prompt ${requestId}`,
    endpoint,
    wait: false,
    expiresAtMs: now.value + 60_000,
    ...(identityId && { originator: { kind: 'explicit' as const, identityId } }),
  });
}

afterEach(() => {
  now.value = 10_000;
  for (const repository of databases.splice(0)) repository.close();
});

describe('request attention service', () => {
  it('allocates ordered identity revisions and exposes only the public metadata projection', () => {
    const { service: requestService } = service();
    const repository = databases[0]!;
    const owner = repository.createIdentity('Attention Owner', 'attention-owner');
    prepare(requestService, 'request-b', owner.id);
    prepare(requestService, 'request-a', owner.id);

    const listing = requestService.listExchanges(owner.id, { limit: 1 });
    expect(listing.items[0]).toMatchObject({
      requestId: 'request-b',
      recipientIdentityId: null,
      preparedAtMs: now.value,
      delivery: 'prepared',
      final: { status: 'not_submitted' },
      revision: 1,
      acknowledged: false,
      settled: false,
      retentionExpiresAtMs: expect.any(Number),
    });
    expect(Object.keys(listing.items[0]!).sort()).toEqual([
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
    expect(listing.nextAfter).toBe(1);
    expect(requestService.listExchanges(owner.id, { after: 1 }).items[0]?.requestId).toBe(
      'request-a'
    );
  });

  it('reopens a single exchange at a newer final revision and applies exact-revision CAS', () => {
    const { repository, service: requestService } = service();
    const owner = repository.createIdentity('Attention Owner', 'attention-owner');
    const prepared = prepare(requestService, 'request-final', owner.id);
    requestService.beginSend(prepared.attemptId);
    requestService.settle(prepared.attemptId, 'sent');
    requestService.submitResponse({
      requestId: prepared.requestId,
      attemptId: prepared.attemptId,
      endpoint,
      body: 'exact final',
    });

    const shown = requestService.showExchange(owner.id, prepared.requestId);
    expect(shown).toMatchObject({
      requestId: prepared.requestId,
      delivery: 'sent',
      revision: 2,
      acknowledged: false,
      settled: false,
      prompt: { status: 'retained', message: 'prompt request-final', messageBytes: 20 },
      final: { status: 'retained', response: 'exact final', bodyBytes: 11 },
    });
    expect(() => requestService.acknowledgeExchange(owner.id, prepared.requestId, 1)).toThrow(
      expect.objectContaining({ code: 'X_REVISION_CONFLICT' })
    );
    expect(requestService.acknowledgeExchange(owner.id, prepared.requestId, 2)).toMatchObject({
      requestId: prepared.requestId,
      revision: 2,
      acknowledged: true,
      changed: true,
    });
    expect(requestService.showExchange(owner.id, prepared.requestId).settled).toBe(true);
    expect(requestService.acknowledgeExchange(owner.id, prepared.requestId, 2).changed).toBe(false);
  });

  it('ackall takes one watermark snapshot and excludes anonymous provenance', () => {
    const { repository, service: requestService } = service();
    const owner = repository.createIdentity('Attention Owner', 'attention-owner');
    prepare(requestService, 'request-owned', owner.id);
    prepare(requestService, 'request-anonymous');
    expect(requestService.acknowledgeAllExchanges(owner.id)).toEqual({ acknowledgedThrough: 1 });
    expect(requestService.listExchanges(owner.id).items).toEqual([]);
    expect(() => requestService.showExchange(owner.id, 'request-anonymous')).toThrow(
      expect.objectContaining({ code: 'X_NOT_FOUND' })
    );
  });

  it('uses X_NOT_FOUND for wrong owner and metadata expiry without exposing storage details', () => {
    const { repository, service: requestService } = service();
    const owner = repository.createIdentity('Attention Owner', 'attention-owner');
    const prepared = prepare(requestService, 'request-expiring', owner.id);
    expect(() => requestService.showExchange('other-identity', prepared.requestId)).toThrow(
      expect.objectContaining({ code: 'X_NOT_FOUND' })
    );
    now.value = repository.findAttempt(prepared.attemptId)!.retentionExpiresAtMs;
    expect(() => requestService.showExchange(owner.id, prepared.requestId)).toThrow(
      expect.objectContaining({ code: 'X_NOT_FOUND' })
    );
  });

  it('distinguishes an expired final from an unavailable body while metadata remains retained', () => {
    const { repository, service: requestService } = service();
    const owner = repository.createIdentity('Attention Owner', 'attention-owner');
    const prepared = prepare(requestService, 'request-expiring-final', owner.id);
    requestService.beginSend(prepared.attemptId);
    requestService.settle(prepared.attemptId, 'sent');
    requestService.submitResponse({
      requestId: prepared.requestId,
      attemptId: prepared.attemptId,
      endpoint,
      body: 'expiring final',
    });
    const response = repository.findResponse(prepared.requestId)!;
    const attention = repository.findExchangeAttention(owner.id, prepared.requestId)!;
    expect(projectExchangeSummary(attention, response.responseExpiresAtMs).final).toEqual({
      status: 'expired',
      submittedAtMs: response.submittedAtMs,
      expiresAtMs: response.responseExpiresAtMs,
    });
    now.value = response.responseExpiresAtMs - 1;
    expect(requestService.listExchanges(owner.id).items[0]?.final).toMatchObject({
      status: 'retained',
      bodyBytes: 14,
    });
    repository.withImmediateTransaction(() => {
      repository.deleteRetainedResponses(response.responseExpiresAtMs, 100);
    });
    expect(requestService.listExchanges(owner.id).items[0]?.final).toEqual({
      status: 'unavailable',
      submittedAtMs: response.submittedAtMs,
      expiresAtMs: response.responseExpiresAtMs,
    });
    const afterBodyCleanup = repository.findExchangeAttention(owner.id, prepared.requestId)!;
    expect(projectExchangeSummary(afterBodyCleanup, response.responseExpiresAtMs).final).toEqual({
      status: 'expired',
      submittedAtMs: response.submittedAtMs,
      expiresAtMs: response.responseExpiresAtMs,
    });
  });

  it('rejects malformed identity, cursor, limit, and revision inputs before storage access', () => {
    const { repository, service: requestService } = service();
    let transactions = 0;
    const originalTransaction = repository.withImmediateTransaction.bind(repository);
    repository.withImmediateTransaction = ((operation: () => unknown) => {
      transactions += 1;
      return originalTransaction(operation);
    }) as typeof repository.withImmediateTransaction;
    const invalid = [
      () => requestService.listExchanges(''),
      () => requestService.listExchanges('owner', { limit: 201 }),
      () => requestService.listExchanges('owner', { after: -1 }),
      () => requestService.listExchanges('owner', { limit: null } as never),
      () => requestService.listExchanges('owner', null as never),
      () => requestService.showExchange('owner', ''),
      () => requestService.acknowledgeExchange('owner', 'request', 0),
    ];
    for (const operation of invalid) {
      expect(operation).toThrow(expect.objectContaining({ code: 'X_INPUT_INVALID' }));
    }
    expect(transactions).toBe(0);
  });

  it.each([false, true])(
    'applies final expiry at equality regardless of physical cleanup (deferred=%s)',
    (deferred) => {
      const { repository, service: requests } = service(1);
      const owner = repository.createIdentity('Expiry Owner', 'expiry-owner');
      const prepared = prepare(requests, 'expiry-boundary', owner.id);
      requests.beginSend(prepared.attemptId);
      requests.settle(prepared.attemptId, 'sent');
      const response = requests.submitResponse({
        requestId: prepared.requestId,
        attemptId: prepared.attemptId,
        endpoint,
        body: 'final',
      });
      const before = repository.findAttempt(prepared.attemptId)!;
      expect(before.retentionExpiresAtMs).toBeGreaterThan(response.responseExpiresAtMs);
      if (deferred) repository.deleteRetainedResponses = () => {};
      now.value = response.responseExpiresAtMs;
      const expectedFinal = {
        status: 'expired',
        submittedAtMs: response.submittedAtMs,
        expiresAtMs: response.responseExpiresAtMs,
      };
      expect(requests.listExchanges(owner.id).items[0]?.final).toEqual(expectedFinal);
      expect(requests.showExchange(owner.id, prepared.requestId).final).toEqual(expectedFinal);
      expect(repository.findResponse(prepared.requestId) !== undefined).toBe(deferred);
      expect(requests.acknowledgeExchange(owner.id, prepared.requestId, 2).changed).toBe(true);
      expect(requests.showExchange(owner.id, prepared.requestId)).toMatchObject({
        final: expectedFinal,
        acknowledged: true,
        settled: true,
      });
      expect(repository.findAttempt(prepared.attemptId)?.retentionExpiresAtMs).toBe(
        before.retentionExpiresAtMs
      );
    }
  );
});
