import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RequestAttemptRecord, RequestEndpoint } from '../request-service.js';
import { openIdentityRepository } from './identity-repository.js';

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
    waitActive: true,
    status: 'prepared',
    injectPreamble: true,
    cadenceReserved: true,
    preparedAtMs: 10,
    expiresAtMs: 100,
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
    repository.deleteRetained(100, 50, 50);
    expect(repository.findAttempt(value.attemptId)).toBeUndefined();
    expect(repository.findAttempt(recent.attemptId)).toBeDefined();
    expect(repository.findAttempt(active.attemptId)).toBeDefined();
    expect(repository.findAttempt(prepared.attemptId)).toBeDefined();
    expect(repository.getPreambleCount(identity.id)).toBe(3);
    repository.close();
  });
});
