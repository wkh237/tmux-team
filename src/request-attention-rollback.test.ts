import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRequestService,
  type RequestEndpoint,
  type RequestService,
} from './request-service.js';
import { openIdentityRepository, type IdentityRepository } from './storage/identity-repository.js';

const START_MS = 10_000;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_REVISION = Number.MAX_SAFE_INTEGER;

const endpoint: RequestEndpoint = {
  serverId: 'attention-rollback-server',
  socketPath: '/tmp/attention-rollback.sock',
  serverPid: 3001,
  serverStartTime: 'attention-rollback-start',
  paneId: '%attention-rollback',
  panePid: 3002,
};

const repositories = new Set<IdentityRepository>();
const directories: string[] = [];

interface Fixture {
  readonly database: string;
  readonly repository: IdentityRepository;
  readonly service: RequestService;
  readonly ownerId: string;
  readonly clock: { value: number };
}

interface DatabaseSnapshot {
  readonly attempts: Array<Record<string, unknown>>;
  readonly responses: Array<Record<string, unknown>>;
  readonly attention: Array<Record<string, unknown>>;
  readonly cadence: Array<Record<string, unknown>>;
}

function fixture(): Fixture {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-request-attention-rollback-'));
  directories.push(directory);
  const database = path.join(directory, 'tmux-team.db');
  const repository = openIdentityRepository(database);
  repositories.add(repository);
  const owner = repository.createIdentity('Rollback Owner', 'rollback-owner');
  const clock = { value: START_MS };
  return {
    database,
    repository,
    service: createRequestService({ repository, now: () => clock.value }),
    ownerId: owner.id,
    clock,
  };
}

function closeRepository(repository: IdentityRepository): void {
  if (repositories.delete(repository)) repository.close();
}

function reopen(value: Fixture): Fixture {
  closeRepository(value.repository);
  const repository = openIdentityRepository(value.database);
  repositories.add(repository);
  return {
    ...value,
    repository,
    service: createRequestService({ repository, now: () => value.clock.value }),
  };
}

function executeSql(databasePath: string, sql: string, ...parameters: unknown[]): void {
  const database = new Database(databasePath);
  try {
    database.prepare(sql).run(...parameters);
  } finally {
    database.close();
  }
}

function snapshot(databasePath: string): DatabaseSnapshot {
  const database = new Database(databasePath, { readonly: true });
  try {
    return {
      attempts: database
        .prepare(
          `SELECT request_id, status, response_submitted_at_ms, attention_revision,
                  attention_acknowledged_revision, message_text, message_bytes,
                  message_expires_at_ms, cadence_reserved, retention_expires_at_ms
           FROM request_attempts ORDER BY request_id`
        )
        .all() as Array<Record<string, unknown>>,
      responses: database
        .prepare(
          `SELECT request_id, attempt_id, body, body_bytes, submitted_at_ms, response_expires_at_ms
           FROM request_responses ORDER BY request_id`
        )
        .all() as Array<Record<string, unknown>>,
      attention: database
        .prepare(
          `SELECT identity_id, latest_revision, acknowledged_through
           FROM request_attention_identities ORDER BY identity_id`
        )
        .all() as Array<Record<string, unknown>>,
      cadence: database
        .prepare(
          `SELECT identity_id, reserved_count, updated_at_ms
           FROM preamble_counters ORDER BY identity_id`
        )
        .all() as Array<Record<string, unknown>>,
    };
  } finally {
    database.close();
  }
}

function prepare(value: Fixture, requestId: string, message: string) {
  return value.service.prepare({
    requestId,
    message,
    endpoint,
    wait: false,
    expiresAtMs: value.clock.value + 60 * 60 * 1000,
    originator: { kind: 'explicit', identityId: value.ownerId },
    preamble: { identityId: value.ownerId, every: 3 },
  });
}

afterEach(() => {
  for (const repository of repositories) repository.close();
  repositories.clear();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('request attention transaction boundaries', () => {
  it('rolls back an exhausted first preparation without request, marker, or cadence writes', () => {
    const value = fixture();
    prepare(value, 'request-existing', 'existing prompt');
    closeRepository(value.repository);
    executeSql(
      value.database,
      'UPDATE request_attention_identities SET latest_revision = ? WHERE identity_id = ?',
      MAX_REVISION,
      value.ownerId
    );
    const reopened = reopen(value);
    const before = snapshot(value.database);

    expect(() => prepare(reopened, 'request-overflow', 'overflow prompt')).toThrow(
      expect.objectContaining({ code: 'X_REVISION_EXHAUSTED' })
    );

    expect(snapshot(value.database)).toEqual(before);
    expect(reopened.repository.findAttemptByRequestId('request-overflow')).toBeUndefined();
  });

  it('rolls back the response and completion marker when the first-final revision is exhausted', () => {
    const value = fixture();
    const prepared = prepare(value, 'request-first-final', 'prompt before overflow');
    value.service.beginSend(prepared.attemptId);
    value.service.settle(prepared.attemptId, 'sent');
    closeRepository(value.repository);
    executeSql(
      value.database,
      'UPDATE request_attention_identities SET latest_revision = ? WHERE identity_id = ?',
      MAX_REVISION,
      value.ownerId
    );
    const reopened = reopen(value);
    const before = snapshot(value.database);

    expect(() =>
      reopened.service.submitResponse({
        requestId: prepared.requestId,
        attemptId: prepared.attemptId,
        endpoint,
        body: 'final before overflow',
      })
    ).toThrow(expect.objectContaining({ code: 'X_REVISION_EXHAUSTED' }));

    expect(snapshot(value.database)).toEqual(before);
    expect(reopened.service.getResponse(prepared.requestId)).toBeUndefined();
    expect(reopened.repository.findAttempt(prepared.attemptId)).toMatchObject({ status: 'sent' });
  });

  it.each([
    { label: 'empty', value: '' },
    { label: 'BOM', value: '\uFEFF' },
    { label: 'NUL', value: '\u0000' },
  ])('shows the exact $label prompt and final bytes', ({ label, value: body }) => {
    const valueFixture = fixture();
    const prepared = prepare(valueFixture, `request-exact-${label}`, body);
    valueFixture.service.beginSend(prepared.attemptId);
    valueFixture.service.settle(prepared.attemptId, 'sent');
    valueFixture.service.submitResponse({
      requestId: prepared.requestId,
      attemptId: prepared.attemptId,
      endpoint,
      body,
    });

    expect(
      valueFixture.service.showExchange(valueFixture.ownerId, prepared.requestId)
    ).toMatchObject({
      prompt: {
        status: 'retained',
        message: body,
        messageBytes: Buffer.byteLength(body, 'utf8'),
        expiresAtMs: START_MS + RETENTION_MS,
      },
      final: {
        status: 'retained',
        response: body,
        submittedAtMs: START_MS,
        bodyBytes: Buffer.byteLength(body, 'utf8'),
        expiresAtMs: START_MS + RETENTION_MS,
      },
    });
  });
});
