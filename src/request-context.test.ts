import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRequestService,
  type RequestAttemptRecord,
  type RequestEndpoint,
  type RequestPromptStorage,
} from './request-service.js';
import {
  RequestInputError,
  MAX_REQUEST_CONTENT_BYTES,
  validateRequestMessage,
} from './domain/request-content.js';
import { openIdentityRepository } from './storage/identity-repository.js';
import { CURRENT_MIGRATIONS } from './storage/migrations.js';
import { createRequestRepository } from './storage/request-repository.js';
import { openStorageWithMigrations, openStorageWithDatabase } from './storage/sqlite-adapter.js';

const directories: string[] = [];
const repositories: Array<{ close(): void }> = [];

const endpoint: RequestEndpoint = {
  serverId: 'server-id',
  socketPath: '/tmp/tmt-server',
  serverPid: 42,
  serverStartTime: 'server-start',
  paneId: '%7',
  panePid: 99,
};

function databaseFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-request-context-'));
  directories.push(directory);
  return path.join(directory, 'tmux-team.db');
}

function attempt(overrides: Partial<RequestAttemptRecord> = {}): RequestAttemptRecord {
  return {
    ...endpoint,
    attemptId: 'attempt-1',
    requestId: 'request-1',
    originator: { kind: 'unknown' },
    waitActive: false,
    status: 'sent',
    injectPreamble: false,
    cadenceReserved: false,
    preparedAtMs: 10,
    settledAtMs: 20,
    expiresAtMs: 100,
    retentionDays: 7,
    retentionExpiresAtMs: 10 + 7 * 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

function prompt(overrides: Partial<RequestPromptStorage> = {}): RequestPromptStorage {
  const message = overrides.message ?? 'original prompt';
  return {
    message,
    messageBytes: Buffer.byteLength(message, 'utf8'),
    expiresAtMs: 1_000,
    ...overrides,
  };
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('request content validation', () => {
  it.each([
    { label: 'empty', message: '' },
    { label: 'BOM CRLF NUL and Unicode', message: '\ufeffBOM\r\nline\u0000🙂' },
    { label: 'exact one MiB', message: 'x'.repeat(MAX_REQUEST_CONTENT_BYTES) },
    {
      label: 'exact one MiB of four-byte Unicode',
      message: '🙂'.repeat(MAX_REQUEST_CONTENT_BYTES / Buffer.byteLength('🙂', 'utf8')),
    },
  ])('preserves exact valid message ($label)', ({ message }) => {
    expect(validateRequestMessage(message)).toEqual({
      message,
      messageBytes: Buffer.byteLength(message, 'utf8'),
    });
  });

  it('rejects malformed Unicode, non-strings, and the first byte over the cap', () => {
    expect(() => validateRequestMessage('\ud800')).toThrowError(RequestInputError);
    expect(() => validateRequestMessage(42)).toThrowError(RequestInputError);
    expect(() => validateRequestMessage('x'.repeat(MAX_REQUEST_CONTENT_BYTES + 1))).toThrowError(
      RequestInputError
    );
    expect(() =>
      validateRequestMessage(
        `${'🙂'.repeat(MAX_REQUEST_CONTENT_BYTES / Buffer.byteLength('🙂', 'utf8'))}x`
      )
    ).toThrowError(RequestInputError);
    try {
      validateRequestMessage('x'.repeat(MAX_REQUEST_CONTENT_BYTES + 1));
    } catch (error) {
      expect(error).toMatchObject({ code: 'REQUEST_INPUT_TOO_LARGE' });
    }
  });
});

describe('request context', () => {
  it('stores exact prompt and provenance without adding content to attempt records', () => {
    const file = databaseFile();
    const repository = openIdentityRepository(file);
    repositories.push(repository);
    const originator = repository.createIdentity('Originator', 'originator');
    const recipient = repository.createIdentity('Recipient', 'recipient');
    let nowMs = 10_000;
    const service = createRequestService({
      repository,
      now: () => nowMs,
      getRetentionDays: () => 90,
    });
    const message = '\ufefforiginal\r\ntext\u0000🙂';

    const preparation = service.prepare({
      requestId: 'request-1',
      message,
      endpoint,
      wait: false,
      expiresAtMs: nowMs + 5_000,
      originator: { kind: 'explicit', identityId: originator.id },
      recipientIdentityId: recipient.id,
    });

    const context = service.getRequestContext('request-1');
    expect(context).toMatchObject({
      attempt: {
        attemptId: preparation.attemptId,
        originator: { kind: 'explicit', identityId: originator.id },
        recipientIdentityId: recipient.id,
      },
      prompt: {
        status: 'retained',
        message,
        messageBytes: Buffer.byteLength(message, 'utf8'),
        expiresAtMs: nowMs + 90 * 24 * 60 * 60 * 1000,
      },
    });
    const attemptRecord = service.getAttempt(preparation.attemptId);
    expect(attemptRecord).not.toHaveProperty('message');
    expect(attemptRecord).not.toHaveProperty('prompt');
    expect(attemptRecord).not.toHaveProperty('messageBytes');
    repository.close();
    const reopened = openIdentityRepository(file);
    repositories.push(reopened);
    expect(
      createRequestService({ repository: reopened, now: () => nowMs }).getRequestContext(
        'request-1'
      )
    ).toEqual(context);
  });

  it('rejects invalid input before cadence or row mutation', () => {
    const repository = openIdentityRepository(databaseFile());
    repositories.push(repository);
    const service = createRequestService({ repository, now: () => 10_000 });

    expect(() =>
      service.prepare({
        requestId: 'invalid',
        message: '\ud800',
        endpoint,
        wait: false,
        expiresAtMs: 20_000,
      })
    ).toThrowError(RequestInputError);
    expect(() =>
      service.prepare({
        requestId: 'too-large',
        message: 'x'.repeat(MAX_REQUEST_CONTENT_BYTES + 1),
        endpoint,
        wait: false,
        expiresAtMs: 20_000,
      })
    ).toThrowError(RequestInputError);
    expect(repository.listAttempts()).toHaveLength(0);
  });

  it('reports expired prompts at equality while retaining the attempt metadata', () => {
    const repository = openIdentityRepository(databaseFile());
    repositories.push(repository);
    let nowMs = 10_000;
    const service = createRequestService({
      repository,
      now: () => nowMs,
      getRetentionDays: () => 1,
    });
    const prepared = service.prepare({
      requestId: 'request-1',
      message: 'prompt',
      endpoint,
      wait: false,
      expiresAtMs: nowMs + 5_000,
    });
    nowMs += 24 * 60 * 60 * 1000;

    expect(service.getRequestContext('request-1')?.prompt).toEqual({
      status: 'expired',
      expiresAtMs: 10_000 + 24 * 60 * 60 * 1000,
    });
    expect(service.getAttempt(prepared.attemptId)).toMatchObject({
      attemptId: prepared.attemptId,
      requestId: 'request-1',
      retentionExpiresAtMs: expect.any(Number),
    });
    const raw = repository.findRequestContext('request-1');
    expect(raw?.promptExpiresAtMs).toBe(10_000 + 24 * 60 * 60 * 1000);
    expect(raw?.promptMessage).toBeUndefined();
  });

  it('rolls back prompt scrubbing with the existing cleanup transaction', () => {
    const repository = openIdentityRepository(databaseFile());
    repositories.push(repository);
    repository.withImmediateTransaction(() => {
      repository.createAttempt(
        attempt({ retentionExpiresAtMs: 10_000_000 }),
        prompt({ expiresAtMs: 100 })
      );
    });
    vi.spyOn(repository, 'deleteRetainedResponses').mockImplementation(() => {
      throw new Error('injected cleanup failure');
    });
    const service = createRequestService({ repository, now: () => 1_000 });

    expect(() => service.cleanup()).toThrow('injected cleanup failure');
    expect(repository.findRequestContext('request-1')?.promptMessage).toBe('original prompt');
  });

  it('scrubs expired prompts in ordered batches of one hundred', () => {
    const repository = openIdentityRepository(databaseFile());
    repositories.push(repository);
    const service = createRequestService({ repository, now: () => 1_000 });
    repository.withImmediateTransaction(() => {
      for (let index = 0; index < 205; index += 1) {
        repository.createAttempt(
          attempt({
            attemptId: `attempt-${index.toString().padStart(3, '0')}`,
            requestId: `request-${index.toString().padStart(3, '0')}`,
            retentionExpiresAtMs: 10_000,
          }),
          prompt({ message: index === 204 ? '' : `prompt-${index}`, expiresAtMs: index + 1 })
        );
      }
    });

    expect(service.getRequestContext('request-204')?.prompt).toEqual({
      status: 'expired',
      expiresAtMs: 205,
    });
    const remainingAfterFirstBatch = repository
      .listAttempts()
      .filter((item) => repository.findRequestContext(item.requestId)?.promptMessage !== undefined)
      .map((item) => item.requestId);
    expect(remainingAfterFirstBatch).toEqual(
      Array.from({ length: 105 }, (_, index) => `request-${index + 100}`)
    );
    expect(repository.findRequestContext('request-204')?.promptMessage).toBe('');

    service.cleanup();
    const remainingAfterSecondBatch = repository
      .listAttempts()
      .filter((item) => repository.findRequestContext(item.requestId)?.promptMessage !== undefined)
      .map((item) => item.requestId);
    expect(remainingAfterSecondBatch).toEqual([
      'request-200',
      'request-201',
      'request-202',
      'request-203',
      'request-204',
    ]);

    service.cleanup();
    expect(
      repository
        .listAttempts()
        .filter(
          (item) => repository.findRequestContext(item.requestId)?.promptMessage !== undefined
        )
    ).toHaveLength(0);
  });

  it('uses the prompt-expiry index without a temporary sort and keeps metadata queries prompt-free', () => {
    const file = databaseFile();
    const lifecycle = openStorageWithDatabase({
      globalDir: path.dirname(file),
      databaseFile: file,
    });
    repositories.push(lifecycle);
    const repository = {
      ...createRequestRepository(() => lifecycle.database),
      withImmediateTransaction<T>(operation: () => T): T {
        return lifecycle.database.transaction(operation).immediate();
      },
    };
    repository.withImmediateTransaction(() => repository.createAttempt(attempt(), prompt()));

    const prepareSpy = vi.spyOn(lifecycle.database, 'prepare');
    repository.findAttempt('attempt-1');
    repository.findAttemptByRequestId('request-1');
    repository.listAttempts();
    repository.listExpiredAttempts(2_000, 100);
    const metadataSql = prepareSpy.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.includes('SELECT'));
    expect(metadataSql.length).toBeGreaterThanOrEqual(4);
    expect(metadataSql.every((sql) => !sql.includes('message_text'))).toBe(true);
    expect(metadataSql.every((sql) => !sql.includes('message_bytes'))).toBe(true);
    expect(metadataSql.every((sql) => !sql.includes('message_expires_at_ms'))).toBe(true);

    prepareSpy.mockClear();
    repository.clearExpiredPrompts(2_000, 100);
    const cleanupSql = prepareSpy.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('UPDATE request_attempts'));
    expect(cleanupSql).toBeDefined();
    expect(
      lifecycle.database.prepare("SELECT name FROM sqlite_master WHERE name = 'sqlite_stat1'").all()
    ).toEqual([]);
    const plan = lifecycle.database
      .prepare(`EXPLAIN QUERY PLAN ${cleanupSql}`)
      .all(2_000, 100) as Array<{ detail: string }>;
    expect(plan.some((row) => row.detail.includes('request_attempts_prompt_expiry'))).toBe(true);
    expect(plan.some((row) => /TEMP B-TREE/i.test(row.detail))).toBe(false);
  });

  it('rolls back a cadence reservation and prompt row together, including after reopen', () => {
    const file = databaseFile();
    const repository = openIdentityRepository(file);
    repositories.push(repository);
    const identity = repository.createIdentity('Cadence', 'cadence');
    const originalCreateAttempt = repository.createAttempt.bind(repository);
    vi.spyOn(repository, 'createAttempt').mockImplementation((...args) => {
      originalCreateAttempt(...args);
      throw new Error('injected prompt insert failure');
    });
    const service = createRequestService({ repository, now: () => 10_000 });

    expect(() =>
      service.prepare({
        requestId: 'rolled-back',
        message: 'must not persist',
        endpoint,
        wait: false,
        expiresAtMs: 20_000,
        preamble: { identityId: identity.id, every: 2 },
      })
    ).toThrow('injected prompt insert failure');
    expect(repository.getPreambleCount(identity.id)).toBe(0);
    expect(repository.listAttempts()).toHaveLength(0);
    repository.close();

    const reopened = openIdentityRepository(file);
    repositories.push(reopened);
    expect(reopened.getPreambleCount(identity.id)).toBe(0);
    expect(reopened.listAttempts()).toHaveLength(0);
  });

  it('rolls back expired prepared/sending/final cleanup as one transaction', () => {
    const repository = openIdentityRepository(databaseFile());
    repositories.push(repository);
    const identity = repository.createIdentity('Cleanup', 'cleanup');
    repository.setPreambleCount(identity.id, 2, 10);
    repository.withImmediateTransaction(() => {
      repository.createAttempt(
        attempt({
          attemptId: 'cleanup-prepared',
          requestId: 'cleanup-prepared-request',
          identityId: identity.id,
          status: 'prepared',
          waitActive: true,
          cadenceReserved: true,
          expiresAtMs: 100,
          retentionExpiresAtMs: 10_000,
        }),
        prompt({ message: 'prepared prompt', expiresAtMs: 100 })
      );
      repository.createAttempt(
        attempt({
          attemptId: 'cleanup-sending',
          requestId: 'cleanup-sending-request',
          identityId: identity.id,
          status: 'sending',
          waitActive: true,
          cadenceReserved: true,
          expiresAtMs: 100,
          retentionExpiresAtMs: 10_000,
        }),
        prompt({ message: 'sending prompt', expiresAtMs: 100 })
      );
      repository.createAttempt(
        attempt({
          attemptId: 'cleanup-final',
          requestId: 'cleanup-final-request',
          status: 'sent',
          waitActive: false,
          settledAtMs: 20,
          expiresAtMs: 100,
          retentionExpiresAtMs: 100,
        }),
        prompt({ message: 'final prompt', expiresAtMs: 100 })
      );
      repository.createResponse({
        requestId: 'cleanup-final-request',
        attemptId: 'cleanup-final',
        endpoint,
        body: 'final body',
        bodyBytes: Buffer.byteLength('final body'),
        submittedAtMs: 20,
        responseExpiresAtMs: 100,
      });
    });
    const service = createRequestService({ repository, now: () => 1_000 });
    const requestIds = [
      'cleanup-prepared-request',
      'cleanup-sending-request',
      'cleanup-final-request',
    ];
    const before = requestIds.map((id) => repository.findRequestContext(id));
    const beforeResponse = repository.findResponse('cleanup-final-request');
    vi.spyOn(repository, 'deleteRetained').mockImplementation(() => {
      throw new Error('injected final cleanup failure');
    });

    expect(() => service.cleanup()).toThrow('injected final cleanup failure');
    expect(requestIds.map((id) => repository.findRequestContext(id))).toEqual(before);
    expect(repository.findResponse('cleanup-final-request')).toEqual(beforeResponse);
    expect(repository.getPreambleCount(identity.id)).toBe(2);
    expect(repository.findAttempt('cleanup-prepared')).toMatchObject({
      status: 'prepared',
      waitActive: true,
      cadenceReserved: true,
      retentionExpiresAtMs: 10_000,
    });
    expect(repository.findAttempt('cleanup-sending')).toMatchObject({
      status: 'sending',
      waitActive: true,
      cadenceReserved: true,
      retentionExpiresAtMs: 10_000,
    });
    expect(repository.findAttempt('cleanup-final')).toMatchObject({
      status: 'sent',
      waitActive: false,
      retentionExpiresAtMs: 100,
      responseSubmittedAtMs: 20,
    });
    expect(repository.findRequestContext('cleanup-prepared-request')?.promptMessage).toBe(
      'prepared prompt'
    );
    expect(repository.findRequestContext('cleanup-sending-request')?.promptMessage).toBe(
      'sending prompt'
    );
    expect(repository.findRequestContext('cleanup-final-request')?.promptMessage).toBe(
      'final prompt'
    );
    expect(repository.findResponse('cleanup-final-request')).toMatchObject({
      body: 'final body',
      responseExpiresAtMs: 100,
    });
  });

  it.each([
    { label: 'unknown with identity', originator: { kind: 'unknown', identityId: null } },
    { label: 'explicit empty identity', originator: { kind: 'explicit', identityId: '' } },
    { label: 'verified missing identity', originator: { kind: 'verified' } },
  ])('rejects invalid provenance: $label before mutation', ({ originator }) => {
    const repository = openIdentityRepository(databaseFile());
    repositories.push(repository);
    const service = createRequestService({ repository, now: () => 10_000 });

    expect(() =>
      service.prepare({
        requestId: 'invalid-provenance',
        message: 'message',
        endpoint,
        wait: false,
        expiresAtMs: 20_000,
        originator: originator as never,
      })
    ).toThrowError(RequestInputError);
    expect(repository.listAttempts()).toHaveLength(0);
  });

  it('reports prompt state before, at, and after expiry while preserving its metadata marker', () => {
    const repository = openIdentityRepository(databaseFile());
    repositories.push(repository);
    repository.withImmediateTransaction(() =>
      repository.createAttempt(
        attempt({ retentionExpiresAtMs: 10_000 }),
        prompt({ expiresAtMs: 1_000 })
      )
    );
    let nowMs = 999;
    const service = createRequestService({ repository, now: () => nowMs });
    expect(service.getRequestContext('request-1')?.prompt).toMatchObject({
      status: 'retained',
      message: 'original prompt',
    });
    nowMs = 1_000;
    expect(service.getRequestContext('request-1')?.prompt).toEqual({
      status: 'expired',
      expiresAtMs: 1_000,
    });
    nowMs = 1_001;
    expect(service.getRequestContext('request-1')?.prompt).toEqual({
      status: 'expired',
      expiresAtMs: 1_000,
    });
    expect(repository.findRequestContext('request-1')?.promptExpiresAtMs).toBe(1_000);
    nowMs = 999;
    expect(service.getRequestContext('request-1')?.prompt).toEqual({
      status: 'expired',
      expiresAtMs: 1_000,
    });
    expect(repository.findRequestContext('request-1')?.promptMessage).toBeUndefined();
  });

  it('keeps prompt context isolated from metadata expiry and drains the out-of-batch rows', () => {
    const repository = openIdentityRepository(databaseFile());
    repositories.push(repository);
    repository.withImmediateTransaction(() => {
      for (let index = 0; index < 105; index += 1) {
        repository.createAttempt(
          attempt({
            attemptId: `isolated-attempt-${index}`,
            requestId: `isolated-request-${index}`,
            retentionExpiresAtMs: 10_000,
          }),
          prompt({
            message: `isolated-${index}`,
            messageBytes: Buffer.byteLength(`isolated-${index}`, 'utf8'),
            expiresAtMs: index + 1,
          })
        );
      }
    });
    let nowMs = 104;
    const service = createRequestService({ repository, now: () => nowMs });
    service.cleanup();
    expect(service.getRequestContext('isolated-request-104')?.prompt).toEqual({
      status: 'retained',
      message: 'isolated-104',
      messageBytes: Buffer.byteLength('isolated-104', 'utf8'),
      expiresAtMs: 105,
    });
    expect(service.getRequestContext('isolated-request-0')?.prompt).toEqual({
      status: 'expired',
      expiresAtMs: 1,
    });

    nowMs = 10_000;
    expect(service.getRequestContext('isolated-request-104')).toBeUndefined();
    expect(repository.findRequestContext('isolated-request-104')?.attempt).toBeDefined();
  });

  it('accepts a late final after prompt expiry without rereading the retention configuration', () => {
    const repository = openIdentityRepository(databaseFile());
    repositories.push(repository);
    let nowMs = 10_000;
    const retentionDays = vi.fn(() => 1);
    const service = createRequestService({
      repository,
      now: () => nowMs,
      getRetentionDays: retentionDays,
    });
    const prepared = service.prepare({
      requestId: 'late-final',
      message: 'prompt expires first',
      endpoint,
      wait: false,
      expiresAtMs: nowMs + 2 * 24 * 60 * 60 * 1000,
    });
    const promptExpiresAtMs = nowMs + 24 * 60 * 60 * 1000;
    expect(retentionDays).toHaveBeenCalledOnce();
    retentionDays.mockImplementation(() => {
      throw new Error('retention configuration is unavailable');
    });
    nowMs = promptExpiresAtMs + 1;
    service.beginSend(prepared.attemptId);
    const response = service.submitResponse({
      requestId: 'late-final',
      attemptId: prepared.attemptId,
      endpoint,
      body: 'late final',
    });
    expect(response.body).toBe('late final');
    expect(response.responseExpiresAtMs).toBe(nowMs + 86_400_000);
    nowMs += 1;
    expect(
      service.submitResponse({
        requestId: 'late-final',
        attemptId: prepared.attemptId,
        endpoint,
        body: 'late final',
      })
    ).toEqual(response);
    expect(service.getRequestContext('late-final')?.prompt).toEqual({
      status: 'expired',
      expiresAtMs: promptExpiresAtMs,
    });
    expect(retentionDays).toHaveBeenCalledOnce();
  });

  it('maps pre-provenance rows to unknown originator and unavailable prompt', () => {
    const file = databaseFile();
    const initial = openStorageWithMigrations(
      { globalDir: path.dirname(file), databaseFile: file },
      CURRENT_MIGRATIONS.slice(0, 6)
    );
    initial.close();
    const database = new Database(file);
    database
      .prepare(
        `INSERT INTO request_attempts (
           attempt_id, request_id, nonce, identity_id, server_id, socket_path, server_pid,
           server_start_time, pane_id, pane_pid, wait_active, status, preamble_every,
           inject_preamble, cadence_reserved, prepared_at_ms, expires_at_ms, retention_days,
           retention_expires_at_ms
         ) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, 0, 'sent', NULL, 0, 0, ?, ?, ?, ?)`
      )
      .run('old-attempt', 'old-request', ...Object.values(endpoint), 10, 20, 7, 30);
    database.close();

    const repository = openIdentityRepository(file);
    repositories.push(repository);
    expect(repository.findRequestContext('old-request')).toMatchObject({
      attempt: { originator: { kind: 'unknown' } },
    });
    expect(repository.findRequestContext('old-request')).not.toHaveProperty('promptMessage');
    const service = createRequestService({ repository, now: () => 20 });
    expect(service.getRequestContext('old-request')?.prompt).toEqual({ status: 'unavailable' });
  });
});
