import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  RequestAttemptRecord,
  RequestEndpoint,
  RequestResponseRecord,
} from '../request-service.js';
import { createRequestService } from '../request-service.js';
import { RETENTION_DAY_MS } from '../domain/exchange-retention.js';
import { openIdentityRepository } from './identity-repository.js';
import { createRequestRepository } from './request-repository.js';
import { openStorageWithDatabase } from './sqlite-adapter.js';

const directories: string[] = [];
const repositories: Array<{ close(): void }> = [];

function databaseFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-request-repository-'));
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

function attempt(overrides: Partial<RequestAttemptRecord> = {}): RequestAttemptRecord {
  return {
    ...endpoint,
    attemptId: 'attempt-1',
    requestId: 'request-1',
    originator: { kind: 'unknown' },
    waitActive: true,
    status: 'prepared',
    injectPreamble: true,
    cadenceReserved: true,
    preparedAtMs: 10,
    expiresAtMs: 100,
    retentionDays: 7,
    retentionExpiresAtMs: 10 + 7 * 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('request repository', () => {
  it('round-trips endpoint evidence and wait lifecycle fields', () => {
    const identityRepository = openIdentityRepository(databaseFile());
    repositories.push(identityRepository);
    // The concrete identity repository composes the request repository over its open connection.
    const identity = identityRepository.createIdentity('Alice', 'alice');
    const value = attempt({ identityId: identity.id, nonce: 'nonce-1', preambleEvery: 3 });
    identityRepository.withImmediateTransaction(() => identityRepository.createAttempt(value));
    expect(identityRepository.findAttempt(value.attemptId)).toEqual(value);
    expect(identityRepository.findActiveRequest(endpoint)).toBe('request-1');
    expect(identityRepository.releaseWait(value.attemptId, 20)).toBe(true);
    expect(identityRepository.findAttempt(value.attemptId)).toMatchObject({
      waitActive: false,
      waitReleasedAtMs: 20,
    });
    identityRepository.close();
  });

  it('uses conditional state transitions and exact request release', () => {
    const repository = openIdentityRepository(databaseFile());
    repositories.push(repository);
    const value = attempt({ attemptId: 'attempt-1' });
    const other = attempt({
      attemptId: 'attempt-2',
      requestId: 'request-2',
      paneId: '%8',
      panePid: 100,
    });
    repository.withImmediateTransaction(() => {
      repository.createAttempt(value);
      repository.createAttempt(other);
    });
    expect(repository.updateAttemptState('attempt-1', 'prepared', 'sending', true, 20)).toBe(true);
    expect(repository.updateAttemptState('attempt-1', 'prepared', 'sending', true, 21)).toBe(false);
    expect(repository.updateAttemptState('attempt-1', 'sending', 'sent', true, 22)).toBe(true);
    expect(repository.findActiveRequest(endpoint)).toBe('request-1');
    expect(repository.releaseWait('attempt-1', 23)).toBe(true);
    expect(repository.findAttempt('attempt-2')).toMatchObject({ waitActive: true });
    expect(repository.releaseWait('attempt-2', 24)).toBe(true);
    expect(repository.findAttempt('attempt-1')).toMatchObject({
      status: 'sent',
      waitActive: false,
    });
    expect(repository.findAttempt('attempt-2')).toMatchObject({ waitActive: false });
    repository.close();
  });

  it('deletes only terminal, released rows after the retention window', () => {
    const repository = openIdentityRepository(databaseFile());
    repositories.push(repository);
    const identity = repository.createIdentity('Alice', 'alice');
    repository.setPreambleCount(identity.id, 3, 1);
    const value = attempt({
      requestId: 'old',
      waitActive: false,
      status: 'sent',
      cadenceReserved: true,
      settledAtMs: 1,
      waitReleasedAtMs: 1,
      retentionExpiresAtMs: 1,
    });
    const recent = attempt({
      attemptId: 'recent',
      requestId: 'recent',
      waitActive: false,
      status: 'sent',
      settledAtMs: 80,
      waitReleasedAtMs: 80,
    });
    const active = attempt({
      attemptId: 'active',
      requestId: 'active',
      waitActive: true,
      status: 'sent',
      settledAtMs: 1,
    });
    const prepared = attempt({
      attemptId: 'prepared',
      requestId: 'prepared',
      expiresAtMs: 200,
    });
    repository.withImmediateTransaction(() => {
      repository.createAttempt(value);
      repository.createAttempt(recent);
      repository.createAttempt(active);
      repository.createAttempt(prepared);
    });
    repository.deleteRetained(24 * 60 * 60 * 1000 + 100, 50);
    expect(repository.findAttempt(value.attemptId)).toBeUndefined();
    expect(repository.findAttempt(recent.attemptId)).toBeDefined();
    expect(repository.findAttempt(active.attemptId)).toBeDefined();
    expect(repository.findAttempt(prepared.attemptId)).toBeDefined();
    expect(repository.getPreambleCount(identity.id)).toBe(3);
    repository.close();
  });

  it('bounds each cleanup candidate phase and orders ties deterministically', () => {
    const repository = openIdentityRepository(databaseFile());
    repositories.push(repository);
    const attempts = Array.from({ length: 101 }, (_, index) =>
      attempt({
        attemptId: `attempt-${String(index).padStart(3, '0')}`,
        requestId: `request-${String(index).padStart(3, '0')}`,
        status: 'sent',
        waitActive: false,
        settledAtMs: 1,
        waitReleasedAtMs: 1,
        retentionExpiresAtMs: 1,
      })
    );
    const pending = Array.from({ length: 101 }, (_, index) =>
      attempt({
        attemptId: `pending-${String(index).padStart(3, '0')}`,
        requestId: `pending-request-${String(index).padStart(3, '0')}`,
        status: 'prepared',
        waitActive: false,
        expiresAtMs: 1,
        retentionExpiresAtMs: 1,
      })
    );
    repository.withImmediateTransaction(() => {
      for (const value of [...attempts, ...pending]) repository.createAttempt(value);
    });

    expect(repository.listExpiredAttempts(100, 100).map((value) => value.attemptId)).toEqual(
      pending.slice(0, 100).map((value) => value.attemptId)
    );

    const responses: RequestResponseRecord[] = attempts.map((value) => ({
      requestId: value.requestId,
      attemptId: value.attemptId,
      endpoint,
      body: value.requestId,
      bodyBytes: value.requestId.length,
      submittedAtMs: 1,
      responseExpiresAtMs: 1,
    }));
    repository.withImmediateTransaction(() => {
      for (const response of responses) repository.createResponse(response);
    });
    repository.deleteRetainedResponses(100, 100);
    expect(responses.filter((response) => repository.findResponse(response.requestId)).length).toBe(
      1
    );
    expect(repository.findResponse('request-100')).toBeDefined();
    expect(repository.findResponse('request-000')).toBeUndefined();
    repository.deleteRetained(24 * 60 * 60 * 1000 + 100, 100);
    expect(repository.listAttempts().filter((value) => value.status === 'sent')).toHaveLength(1);
  });

  it('keeps metadata cleanup on the ordered horizon index without ANALYZE', () => {
    const file = databaseFile();
    const storage = openStorageWithDatabase({ globalDir: path.dirname(file), databaseFile: file });
    repositories.push(storage);
    const database = storage.database;
    const seedRepository = createRequestRepository(() => database);
    const terminalAttempts = Array.from({ length: 2_000 }, (_, index) =>
      attempt({
        attemptId: `plan-attempt-${String(index).padStart(4, '0')}`,
        requestId: `plan-request-${String(index).padStart(4, '0')}`,
        waitActive: false,
        status: 'sent',
        settledAtMs: 1,
        waitReleasedAtMs: 1,
        retentionExpiresAtMs: 1,
      })
    );
    database.transaction(() => {
      for (const value of terminalAttempts) seedRepository.createAttempt(value);
    })();

    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE name = 'sqlite_stat1'").all()
    ).toEqual([]);

    const preparedSql: string[] = [];
    const observedDatabase = new Proxy(database, {
      get(target, property, receiver) {
        if (property === 'prepare') {
          return (sql: string) => {
            preparedSql.push(sql);
            return target.prepare(sql);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const repository = createRequestRepository(() => observedDatabase);
    const nowMs = 10 * RETENTION_DAY_MS;
    repository.deleteRetained(nowMs, 100);

    const deleteSql = preparedSql.find((sql) => sql.includes('DELETE FROM request_attempts'));
    if (!deleteSql) throw new Error('Expected production metadata cleanup SQL.');
    const plan = database
      .prepare(`EXPLAIN QUERY PLAN ${deleteSql}`)
      .all(nowMs - RETENTION_DAY_MS, nowMs, nowMs, 100) as Array<{ detail: string }>;
    const details = plan.map((row) => row.detail);
    expect(details).toEqual(
      expect.arrayContaining([expect.stringContaining('request_attempts_retention_horizon')])
    );
    expect(details.some((detail) => detail.includes('USE TEMP B-TREE FOR ORDER BY'))).toBe(false);

    const withoutHint = deleteSql.replace(' INDEXED BY request_attempts_retention_horizon', '');
    expect(withoutHint).not.toBe(deleteSql);
    const unhintedPlan = database
      .prepare(`EXPLAIN QUERY PLAN ${withoutHint}`)
      .all(nowMs - RETENTION_DAY_MS, nowMs, nowMs, 100) as Array<{ detail: string }>;
    expect(unhintedPlan.map((row) => row.detail)).toContain('USE TEMP B-TREE FOR ORDER BY');
  });

  it('drains more than one batch of expired transitions, bodies, and metadata in order', () => {
    const repository = openIdentityRepository(databaseFile());
    repositories.push(repository);
    const cleanupNow = 10 * RETENTION_DAY_MS;
    const pending = Array.from({ length: 205 }, (_, index) =>
      attempt({
        attemptId: `pending-${String(index).padStart(3, '0')}`,
        requestId: `pending-request-${String(index).padStart(3, '0')}`,
        waitActive: true,
        status: 'prepared',
        expiresAtMs: 1,
        retentionExpiresAtMs: cleanupNow + RETENTION_DAY_MS,
      })
    );
    const retained = Array.from({ length: 205 }, (_, index) =>
      attempt({
        attemptId: `retained-${String(index).padStart(3, '0')}`,
        requestId: `retained-request-${String(index).padStart(3, '0')}`,
        waitActive: false,
        status: 'sent',
        settledAtMs: cleanupNow - 2 * RETENTION_DAY_MS,
        waitReleasedAtMs: cleanupNow - 2 * RETENTION_DAY_MS,
        retentionExpiresAtMs: cleanupNow - 1,
      })
    );
    const responses: RequestResponseRecord[] = retained.map((value) => ({
      requestId: value.requestId,
      attemptId: value.attemptId,
      endpoint,
      body: value.requestId,
      bodyBytes: value.requestId.length,
      submittedAtMs: cleanupNow - 2 * RETENTION_DAY_MS,
      responseExpiresAtMs: cleanupNow - 1,
    }));

    repository.withImmediateTransaction(() => {
      for (const value of [...pending, ...retained]) repository.createAttempt(value);
      for (const response of responses) repository.createResponse(response);
    });

    const service = createRequestService({ repository, now: () => cleanupNow });
    service.cleanup();
    expect(repository.findAttempt(pending[0]!.attemptId)).toMatchObject({
      status: 'definitely_failed',
      waitActive: false,
    });
    expect(repository.findAttempt(pending[100]!.attemptId)).toMatchObject({
      status: 'prepared',
      waitActive: true,
    });
    expect(repository.listAttempts().filter((value) => value.status === 'sent')).toHaveLength(105);
    expect(repository.listAttempts().filter((value) => value.status === 'prepared')).toHaveLength(
      105
    );
    expect(responses.filter((value) => repository.findResponse(value.requestId))).toHaveLength(105);
    expect(repository.findAttempt(retained[100]!.attemptId)).toBeDefined();
    expect(repository.findAttempt(retained[0]!.attemptId)).toBeUndefined();

    service.cleanup();
    expect(repository.listAttempts().filter((value) => value.status === 'sent')).toHaveLength(5);
    expect(repository.listAttempts().filter((value) => value.status === 'prepared')).toHaveLength(
      5
    );
    expect(responses.filter((value) => repository.findResponse(value.requestId))).toHaveLength(5);
    expect(repository.findAttempt(retained[199]!.attemptId)).toBeUndefined();
    expect(repository.findAttempt(retained[200]!.attemptId)).toBeDefined();

    service.cleanup();
    expect(repository.listAttempts().filter((value) => value.status === 'sent')).toHaveLength(0);
    expect(repository.listAttempts().filter((value) => value.status === 'prepared')).toHaveLength(
      0
    );
    expect(responses.filter((value) => repository.findResponse(value.requestId))).toHaveLength(0);
    expect(repository.listAttempts()).toHaveLength(205);
    expect(repository.listAttempts().every((value) => value.status === 'definitely_failed')).toBe(
      true
    );
  });

  it('rolls back service cleanup after transitions and body deletion fail', () => {
    const repository = openIdentityRepository(databaseFile());
    repositories.push(repository);
    const cleanupNow = 10 * RETENTION_DAY_MS;
    const identity = repository.createIdentity('Cleanup', 'cleanup');
    repository.setPreambleCount(identity.id, 5, cleanupNow - 1);
    const pending = attempt({
      attemptId: 'rollback-pending',
      requestId: 'rollback-pending-request',
      identityId: identity.id,
      waitActive: true,
      status: 'prepared',
      cadenceReserved: true,
      expiresAtMs: 1,
      retentionExpiresAtMs: cleanupNow + RETENTION_DAY_MS,
    });
    const retained = Array.from({ length: 3 }, (_, index) =>
      attempt({
        attemptId: `rollback-${index}`,
        requestId: `rollback-request-${index}`,
        waitActive: false,
        status: 'sent',
        settledAtMs: cleanupNow - 2 * RETENTION_DAY_MS,
        waitReleasedAtMs: cleanupNow - 2 * RETENTION_DAY_MS,
        retentionExpiresAtMs: cleanupNow - 1,
      })
    );
    repository.withImmediateTransaction(() => {
      repository.createAttempt(pending);
      for (const value of retained) repository.createAttempt(value);
      for (const value of retained) {
        repository.createResponse({
          requestId: value.requestId,
          attemptId: value.attemptId,
          endpoint,
          body: value.requestId,
          bodyBytes: value.requestId.length,
          submittedAtMs: cleanupNow - 2 * RETENTION_DAY_MS,
          responseExpiresAtMs: cleanupNow - 1,
        });
      }
    });
    const beforeAttempts = [pending, ...retained].map((value) =>
      repository.findAttempt(value.attemptId)
    );
    const beforeResponses = retained.map((value) => repository.findResponse(value.requestId));
    const service = createRequestService({ repository, now: () => cleanupNow });
    const deleteSpy = vi.spyOn(repository, 'deleteRetained').mockImplementation(() => {
      throw new Error('simulated cleanup failure');
    });

    expect(() => service.cleanup()).toThrow('simulated cleanup failure');
    deleteSpy.mockRestore();
    expect([pending, ...retained].map((value) => repository.findAttempt(value.attemptId))).toEqual(
      beforeAttempts
    );
    expect(retained.map((value) => repository.findResponse(value.requestId))).toEqual(
      beforeResponses
    );
    expect(repository.getPreambleCount(identity.id)).toBe(5);
  });
});
