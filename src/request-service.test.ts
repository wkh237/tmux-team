import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRequestService, type RequestEndpoint } from './request-service.js';
import { openIdentityRepository } from './storage/identity-repository.js';

const directories: string[] = [];
const repositories: Array<{ close(): void }> = [];

function databaseFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-request-service-'));
  directories.push(directory);
  return path.join(directory, 'tmux-team.db');
}

const endpoint: RequestEndpoint = {
  serverId: 'server-id',
  socketPath: '/tmp/tmt-server',
  serverPid: 42,
  serverStartTime: 'server-start',
  paneId: '%7',
  panePid: 99,
};

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('request service', () => {
  it('reserves cadence and fences the request through send and waiter release', () => {
    const repository = openIdentityRepository(databaseFile());
    repositories.push(repository);
    const identity = repository.createIdentity('Alice', 'alice');
    let nowMs = 10_000;
    const service = createRequestService({ repository, now: () => nowMs });

    const prepared = service.prepare({
      requestId: 'request-1',
      nonce: 'nonce-1',
      endpoint,
      wait: true,
      expiresAtMs: nowMs + 5_000,
      preamble: { identityId: identity.id, every: 3 },
    });
    expect(prepared).toMatchObject({
      requestId: 'request-1',
      injectPreamble: true,
    });
    expect(service.getAttempt(prepared.attemptId)).toMatchObject({
      status: 'prepared',
      waitActive: true,
      cadenceReserved: true,
      expiresAtMs: nowMs + 60 * 60 * 1000,
    });

    service.beginSend(prepared.attemptId);
    service.settle(prepared.attemptId, 'sent');
    service.releaseWait(prepared.attemptId);
    expect(service.getAttempt(prepared.attemptId)).toMatchObject({
      status: 'sent',
      waitActive: false,
    });
    repository.close();
  });

  it('refunds a proven failed reservation without rewriting a prepared payload', () => {
    const repository = openIdentityRepository(databaseFile());
    repositories.push(repository);
    const identity = repository.createIdentity('Alice', 'alice');
    let nowMs = 10_000;
    const service = createRequestService({ repository, now: () => nowMs });

    const first = service.prepare({
      requestId: 'request-1',
      endpoint,
      wait: false,
      expiresAtMs: nowMs + 5_000,
      preamble: { identityId: identity.id, every: 3 },
    });
    const second = service.prepare({
      requestId: 'request-2',
      endpoint,
      wait: false,
      expiresAtMs: nowMs + 5_000,
      preamble: { identityId: identity.id, every: 3 },
    });
    expect(first.injectPreamble).toBe(true);
    expect(second.injectPreamble).toBe(false);

    service.settle(first.attemptId, 'definitely_failed');
    const third = service.prepare({
      requestId: 'request-3',
      endpoint,
      wait: false,
      expiresAtMs: nowMs + 5_000,
      preamble: { identityId: identity.id, every: 3 },
    });
    expect(third.injectPreamble).toBe(false);
    expect(service.getAttempt(first.attemptId)).toMatchObject({
      status: 'definitely_failed',
      cadenceReserved: false,
    });
    expect(service.getAttempt(second.attemptId)).toMatchObject({
      status: 'prepared',
      injectPreamble: false,
    });
    repository.close();
  });

  it('does not refund uncertain delivery and never replaces an active request', () => {
    const repository = openIdentityRepository(databaseFile());
    repositories.push(repository);
    const identity = repository.createIdentity('Alice', 'alice');
    let nowMs = 10_000;
    const service = createRequestService({ repository, now: () => nowMs });

    const first = service.prepare({
      requestId: 'request-1',
      endpoint,
      wait: true,
      expiresAtMs: nowMs + 5_000,
      preamble: { identityId: identity.id, every: 3 },
    });
    const second = service.prepare({
      requestId: 'request-2',
      endpoint,
      wait: true,
      expiresAtMs: nowMs + 5_000,
      preamble: { identityId: identity.id, every: 3 },
    });
    expect(second.previousRequestId).toBe('request-1');

    service.beginSend(first.attemptId);
    service.settle(first.attemptId, 'uncertain');
    service.releaseWait(first.attemptId);
    service.releaseWait(first.attemptId);
    expect(service.getAttempt(first.attemptId)).toMatchObject({
      status: 'uncertain',
      waitActive: false,
      cadenceReserved: true,
    });
    expect(service.getAttempt(second.attemptId)?.waitActive).toBe(true);
    repository.close();
  });

  it('rejects duplicate request IDs atomically without consuming cadence', () => {
    const repository = openIdentityRepository(databaseFile());
    repositories.push(repository);
    const identity = repository.createIdentity('Alice', 'alice');
    let nowMs = 10_000;
    const service = createRequestService({ repository, now: () => nowMs });
    const input = {
      requestId: 'request-1',
      endpoint,
      wait: false,
      expiresAtMs: nowMs + 5_000,
      preamble: { identityId: identity.id, every: 3 },
    } as const;
    expect(service.prepare(input).injectPreamble).toBe(true);
    expect(() => service.prepare(input)).toThrow();
    expect(repository.getPreambleCount(identity.id)).toBe(1);
    expect(repository.listAttempts()).toHaveLength(1);
    const next = service.prepare({ ...input, requestId: 'request-2' });
    expect(next.injectPreamble).toBe(false);
    expect(repository.getPreambleCount(identity.id)).toBe(2);
    repository.close();
  });

  it('expires prepared attempts with a refund and sending attempts as uncertain', () => {
    const repository = openIdentityRepository(databaseFile());
    repositories.push(repository);
    const identity = repository.createIdentity('Alice', 'alice');
    let nowMs = 10_000;
    const service = createRequestService({ repository, now: () => nowMs });
    const prepared = service.prepare({
      requestId: 'request-1',
      endpoint,
      wait: true,
      expiresAtMs: nowMs + 1,
      preamble: { identityId: identity.id, every: 3 },
    });
    const sending = service.prepare({
      requestId: 'request-2',
      endpoint: { ...endpoint, paneId: '%8', panePid: 100 },
      wait: true,
      expiresAtMs: nowMs + 1,
      preamble: { identityId: identity.id, every: 3 },
    });
    const completed = service.prepare({
      requestId: 'request-3',
      endpoint: { ...endpoint, paneId: '%9', panePid: 101 },
      wait: true,
      expiresAtMs: nowMs + 1,
    });
    service.beginSend(sending.attemptId);
    service.beginSend(completed.attemptId);
    service.settle(completed.attemptId, 'sent');
    nowMs += 60 * 60 * 1000 + 1;
    service.cleanup();

    expect(service.getAttempt(prepared.attemptId)).toMatchObject({
      status: 'definitely_failed',
      cadenceReserved: false,
    });
    expect(service.getAttempt(sending.attemptId)).toMatchObject({
      status: 'uncertain',
      cadenceReserved: true,
    });
    expect(service.getAttempt(completed.attemptId)).toMatchObject({
      status: 'sent',
      waitActive: false,
    });
    repository.close();
  });

  it('persists an expired-prepared refund before rejecting a late begin', () => {
    const repository = openIdentityRepository(databaseFile());
    repositories.push(repository);
    const identity = repository.createIdentity('Alice', 'alice');
    let nowMs = 10_000;
    const service = createRequestService({ repository, now: () => nowMs });
    const prepared = service.prepare({
      requestId: 'request-1',
      endpoint,
      wait: true,
      expiresAtMs: nowMs + 1,
      preamble: { identityId: identity.id, every: 3 },
    });

    nowMs += 60 * 60 * 1000 + 1;
    expect(() => service.beginSend(prepared.attemptId)).toThrow(/expired/);
    expect(service.getAttempt(prepared.attemptId)).toMatchObject({
      status: 'definitely_failed',
      cadenceReserved: false,
      waitActive: false,
    });
    expect(() => service.beginSend(prepared.attemptId)).toThrow(/definitely_failed/);
    repository.close();
  });

  it('checks expiry after entering the write transaction', () => {
    const repository = openIdentityRepository(databaseFile());
    repositories.push(repository);
    const identity = repository.createIdentity('Alice', 'alice');
    let nowMs = 10_000;
    let advanceAtTransaction = false;
    const transactionalRepository = {
      ...repository,
      withImmediateTransaction<T>(operation: () => T): T {
        if (advanceAtTransaction) nowMs += 60 * 60 * 1000 + 1;
        return repository.withImmediateTransaction(operation);
      },
    };
    const service = createRequestService({
      repository: transactionalRepository,
      now: () => nowMs,
    });
    const prepared = service.prepare({
      requestId: 'request-1',
      endpoint,
      wait: true,
      expiresAtMs: nowMs + 1,
      preamble: { identityId: identity.id, every: 3 },
    });

    advanceAtTransaction = true;
    expect(() => service.beginSend(prepared.attemptId)).toThrow(/expired/);
    expect(service.getAttempt(prepared.attemptId)).toMatchObject({
      status: 'definitely_failed',
      waitActive: false,
      cadenceReserved: false,
    });
    expect(repository.getPreambleCount(identity.id)).toBe(0);
    repository.close();
  });

  it('rejects beginSend replay in every post-prepare state without new reservations', () => {
    const repository = openIdentityRepository(databaseFile());
    repositories.push(repository);
    const identity = repository.createIdentity('Alice', 'alice');
    let nowMs = 10_000;
    const service = createRequestService({ repository, now: () => nowMs });
    const sending = service.prepare({
      requestId: 'sending',
      endpoint: { ...endpoint, paneId: '%10', panePid: 110 },
      wait: false,
      expiresAtMs: nowMs + 5_000,
      preamble: { identityId: identity.id, every: 3 },
    });
    service.beginSend(sending.attemptId);
    expect(() => service.beginSend(sending.attemptId)).toThrow(/already sending/);
    service.settle(sending.attemptId, 'sent');
    expect(() => service.beginSend(sending.attemptId)).toThrow(/already sent/);

    const uncertain = service.prepare({
      requestId: 'uncertain',
      endpoint: { ...endpoint, paneId: '%11', panePid: 111 },
      wait: false,
      expiresAtMs: nowMs + 5_000,
      preamble: { identityId: identity.id, every: 3 },
    });
    service.beginSend(uncertain.attemptId);
    service.settle(uncertain.attemptId, 'uncertain');
    expect(() => service.beginSend(uncertain.attemptId)).toThrow(/already uncertain/);

    const failed = service.prepare({
      requestId: 'failed',
      endpoint: { ...endpoint, paneId: '%12', panePid: 112 },
      wait: false,
      expiresAtMs: nowMs + 5_000,
      preamble: { identityId: identity.id, every: 3 },
    });
    service.settle(failed.attemptId, 'definitely_failed');
    expect(() => service.beginSend(failed.attemptId)).toThrow(/already definitely_failed/);
    expect(repository.getPreambleCount(identity.id)).toBe(2);
  });

  it('refunds explicit definitely_failed proof from unexpired sending exactly once', () => {
    const repository = openIdentityRepository(databaseFile());
    repositories.push(repository);
    const identity = repository.createIdentity('Alice', 'alice');
    let nowMs = 10_000;
    const service = createRequestService({ repository, now: () => nowMs });
    const prepared = service.prepare({
      requestId: 'request-1',
      endpoint,
      wait: false,
      expiresAtMs: nowMs + 5_000,
      preamble: { identityId: identity.id, every: 3 },
    });
    service.beginSend(prepared.attemptId);
    service.settle(prepared.attemptId, 'definitely_failed');
    expect(repository.getPreambleCount(identity.id)).toBe(0);
    expect(() => service.settle(prepared.attemptId, 'definitely_failed')).not.toThrow();
    expect(repository.getPreambleCount(identity.id)).toBe(0);
  });

  it('converts an expired sending definitely_failed settlement to uncertain', () => {
    const repository = openIdentityRepository(databaseFile());
    repositories.push(repository);
    const identity = repository.createIdentity('Alice', 'alice');
    let nowMs = 10_000;
    const service = createRequestService({ repository, now: () => nowMs });
    const prepared = service.prepare({
      requestId: 'request-1',
      endpoint,
      wait: false,
      expiresAtMs: nowMs + 1,
      preamble: { identityId: identity.id, every: 3 },
    });
    service.beginSend(prepared.attemptId);
    nowMs += 60 * 60 * 1000 + 1;
    service.settle(prepared.attemptId, 'definitely_failed');
    expect(service.getAttempt(prepared.attemptId)).toMatchObject({
      status: 'uncertain',
      cadenceReserved: true,
    });
    expect(repository.getPreambleCount(identity.id)).toBe(1);
  });

  it('releases stale terminal waiters before retention pruning', () => {
    const repository = openIdentityRepository(databaseFile());
    repositories.push(repository);
    let nowMs = 10_000;
    const service = createRequestService({ repository, now: () => nowMs });
    const prepared = service.prepare({
      requestId: 'request-1',
      endpoint,
      wait: true,
      expiresAtMs: nowMs + 1,
    });
    service.beginSend(prepared.attemptId);
    service.settle(prepared.attemptId, 'sent');
    nowMs += 60 * 60 * 1000 + 1;
    service.cleanup();
    expect(service.getAttempt(prepared.attemptId)).toMatchObject({
      status: 'sent',
      waitActive: false,
    });

    nowMs += 24 * 60 * 60 * 1000 + 1;
    service.cleanup();
    expect(service.getAttempt(prepared.attemptId)).toBeUndefined();
  });

  it('rejects settlement before begin and preserves idempotent terminal settlement', () => {
    const repository = openIdentityRepository(databaseFile());
    repositories.push(repository);
    const service = createRequestService({ repository, now: () => 10_000 });
    const prepared = service.prepare({
      requestId: 'request-1',
      endpoint,
      wait: false,
      expiresAtMs: 20_000,
    });
    expect(() => service.settle(prepared.attemptId, 'sent')).toThrow(/still prepared/);
    service.beginSend(prepared.attemptId);
    service.settle(prepared.attemptId, 'sent');
    expect(() => service.settle(prepared.attemptId, 'sent')).not.toThrow();
    expect(() => service.settle(prepared.attemptId, 'uncertain')).toThrow(/already sent/);
    repository.close();
  });
});
