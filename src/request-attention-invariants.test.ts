import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRequestService,
  type RequestEndpoint,
  type RequestService,
} from './request-service.js';
import { openIdentityRepository, type IdentityRepository } from './storage/identity-repository.js';

const directories: string[] = [];
const repositories: IdentityRepository[] = [];
const DAY_MS = 24 * 60 * 60 * 1000;
const START_MS = 10_000;

const endpoint: RequestEndpoint = {
  serverId: 'attention-invariant-server',
  socketPath: '/tmp/attention-invariant.sock',
  serverPid: 901,
  serverStartTime: 'attention-invariant-start',
  paneId: '%attention-invariant',
  panePid: 902,
};

interface Fixture {
  readonly database: string;
  readonly repository: IdentityRepository;
  readonly service: RequestService;
  readonly clock: { value: number };
  readonly ownerId: string;
}

function fixture(retentionDays = 7): Fixture {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-attention-invariants-'));
  directories.push(directory);
  const database = path.join(directory, 'tmux-team.db');
  const repository = openIdentityRepository(database);
  repositories.push(repository);
  const owner = repository.createIdentity('Attention Owner', 'attention-owner');
  const clock = { value: START_MS };
  return {
    database,
    repository,
    service: createRequestService({
      repository,
      now: () => clock.value,
      getRetentionDays: () => retentionDays,
    }),
    clock,
    ownerId: owner.id,
  };
}

function prepare(
  value: Fixture,
  requestId: string,
  identityId = value.ownerId,
  options: {
    readonly endpoint?: RequestEndpoint;
    readonly wait?: boolean;
  } = {}
) {
  return value.service.prepare({
    requestId,
    message: `prompt for ${requestId}`,
    endpoint: options.endpoint ?? endpoint,
    wait: options.wait ?? false,
    expiresAtMs: value.clock.value + 60 * 60 * 1000,
    originator: { kind: 'explicit', identityId },
  });
}

function rawAttempts(value: Fixture): Array<{
  request_id: string;
  status: string;
  message_text: string | null;
  attention_revision: number;
  attention_acknowledged_revision: number;
}> {
  const database = new Database(value.database, { readonly: true });
  try {
    return database
      .prepare(
        `SELECT request_id, status, message_text, attention_revision,
                attention_acknowledged_revision
         FROM request_attempts ORDER BY request_id`
      )
      .all() as Array<{
      request_id: string;
      status: string;
      message_text: string | null;
      attention_revision: number;
      attention_acknowledged_revision: number;
    }>;
  } finally {
    database.close();
  }
}

function rawWatermark(value: Fixture): {
  identity_id: string;
  latest_revision: number;
  acknowledged_through: number;
}[] {
  const database = new Database(value.database, { readonly: true });
  try {
    return database
      .prepare(
        'SELECT identity_id, latest_revision, acknowledged_through FROM request_attention_identities ORDER BY identity_id'
      )
      .all() as {
      identity_id: string;
      latest_revision: number;
      acknowledged_through: number;
    }[];
  } finally {
    database.close();
  }
}

function rawResponse(value: Fixture, requestId: string): unknown {
  const database = new Database(value.database, { readonly: true });
  try {
    return database
      .prepare(
        'SELECT request_id, body, submitted_at_ms FROM request_responses WHERE request_id = ?'
      )
      .get(requestId);
  } finally {
    database.close();
  }
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('request attention service invariants', () => {
  it('ackall performs one watermark write without enumerating or updating request rows', () => {
    const value = fixture();
    for (let index = 0; index < 220; index += 1) {
      prepare(value, `request-ackall-${String(index).padStart(3, '0')}`);
    }

    const database = new Database(value.database);
    try {
      database.exec(`
        CREATE TABLE attention_write_audit (table_name TEXT NOT NULL);
        CREATE TRIGGER audit_attempt_attention_update
        AFTER UPDATE OF attention_acknowledged_revision ON request_attempts
        BEGIN INSERT INTO attention_write_audit VALUES ('request_attempts'); END;
        CREATE TRIGGER audit_identity_attention_update
        AFTER UPDATE OF acknowledged_through ON request_attention_identities
        BEGIN INSERT INTO attention_write_audit VALUES ('request_attention_identities'); END;
      `);
      const listSpy = vi.spyOn(value.repository, 'listExchangeAttention');
      const prepareSpy = vi.spyOn(Database.prototype, 'prepare');
      let statements: string[] = [];

      try {
        expect(value.service.acknowledgeAllExchanges(value.ownerId)).toEqual({
          acknowledgedThrough: 220,
        });
        statements = prepareSpy.mock.calls.map(([sql]) => String(sql));
      } finally {
        prepareSpy.mockRestore();
      }
      expect(listSpy).not.toHaveBeenCalled();
      expect(statements.some((sql) => /\bCOUNT\s*\(/i.test(sql))).toBe(false);
      expect(
        statements.some(
          (sql) =>
            sql.includes('UPDATE request_attention_identities') &&
            sql.includes('acknowledged_through')
        )
      ).toBe(true);
      expect(
        statements.some(
          (sql) => sql.includes('request_attention_identities') && sql.includes('request_attempts')
        )
      ).toBe(false);
      const requestStatements = statements.filter((sql) => sql.includes('request_attempts'));
      expect(requestStatements.length).toBeGreaterThan(0);
      expect(requestStatements.every((sql) => /\bLIMIT\s+\?/i.test(sql))).toBe(true);
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM attention_write_audit WHERE table_name = 'request_attempts'"
          )
          .get()
      ).toEqual({ count: 0 });
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM attention_write_audit WHERE table_name = 'request_attention_identities'"
          )
          .get()
      ).toEqual({ count: 1 });

      expect(value.service.acknowledgeAllExchanges(value.ownerId)).toEqual({
        acknowledgedThrough: 220,
      });
      expect(rawWatermark(value)).toEqual([
        { identity_id: value.ownerId, latest_revision: 220, acknowledged_through: 220 },
      ]);
    } finally {
      database.close();
    }
  });

  it('uses an indexed metadata-only list query without loading prompt or body text', () => {
    const value = fixture();
    prepare(value, 'request-list-metadata');
    const prepareSpy = vi.spyOn(Database.prototype, 'prepare');
    let listSql: string | undefined;
    try {
      expect(value.service.listExchanges(value.ownerId, { limit: 50 }).items).toHaveLength(1);
      listSql = prepareSpy.mock.calls
        .map(([sql]) => String(sql))
        .find(
          (sql) =>
            sql.includes('request_attention_identities') &&
            sql.includes('ORDER BY a.attention_revision')
        );
    } finally {
      prepareSpy.mockRestore();
    }

    expect(listSql).toBeDefined();
    expect(listSql).toMatch(/LIMIT\s+\?/i);
    expect(listSql).not.toContain('message_text');
    expect(listSql).not.toContain('message_bytes');
    expect(listSql).not.toMatch(/response\.body(?:\s|,)/);

    const database = new Database(value.database, { readonly: true });
    try {
      const plan = database
        .prepare(`EXPLAIN QUERY PLAN ${listSql!}`)
        .all(value.ownerId, 0, value.clock.value, 51) as Array<{ detail: string }>;
      expect(plan.some((row) => row.detail.includes('request_attempts_attention'))).toBe(true);
      expect(plan.some((row) => /TEMP B-TREE FOR ORDER BY/i.test(row.detail))).toBe(false);
      expect(plan.some((row) => /\bSCAN (?:a|request_attempts)\b/i.test(row.detail))).toBe(false);
    } finally {
      database.close();
    }
  });

  it('keeps empty and repeated ackall calls identity-scoped and watermark-idempotent', () => {
    const value = fixture();
    const other = value.repository.createIdentity('Other Owner', 'other-owner');
    const empty = value.repository.createIdentity('Empty Owner', 'empty-owner');
    prepare(value, 'request-owner', value.ownerId);
    prepare(value, 'request-other', other.id);

    expect(value.service.acknowledgeAllExchanges(value.ownerId)).toEqual({
      acknowledgedThrough: 1,
    });
    expect(value.service.listExchanges(value.ownerId).items).toEqual([]);
    expect(value.service.listExchanges(other.id).items.map((item) => item.requestId)).toEqual([
      'request-other',
    ]);
    expect(value.service.acknowledgeAllExchanges(value.ownerId)).toEqual({
      acknowledgedThrough: 1,
    });
    expect(value.service.acknowledgeAllExchanges(empty.id)).toEqual({ acknowledgedThrough: 0 });
    expect(value.service.listExchanges(empty.id).items).toEqual([]);
    const watermarks = rawWatermark(value);
    expect(watermarks).toHaveLength(2);
    expect(watermarks).toEqual(
      expect.arrayContaining([
        { identity_id: value.ownerId, latest_revision: 1, acknowledged_through: 1 },
        { identity_id: other.id, latest_revision: 1, acknowledged_through: 0 },
      ])
    );
  });

  it('retains the identity counter after metadata deletion and repository reopen', () => {
    const value = fixture(1);
    const first = prepare(value, 'request-cleanup-first', value.ownerId, { wait: true });
    value.service.beginSend(first.attemptId);
    value.service.settle(first.attemptId, 'sent');
    value.service.releaseWait(first.attemptId);
    value.clock.value += 8 * DAY_MS + 1;
    value.service.cleanup();

    expect(rawAttempts(value)).toEqual([]);
    expect(rawWatermark(value)).toEqual([
      { identity_id: value.ownerId, latest_revision: 1, acknowledged_through: 0 },
    ]);

    value.repository.close();
    const reopened = openIdentityRepository(value.database);
    repositories.push(reopened);
    const reopenedService = createRequestService({
      repository: reopened,
      now: () => value.clock.value,
      getRetentionDays: () => 1,
    });
    reopenedService.prepare({
      requestId: 'request-cleanup-second',
      message: 'prompt for request-cleanup-second',
      endpoint,
      wait: false,
      expiresAtMs: value.clock.value + 60 * 60 * 1000,
      originator: { kind: 'explicit', identityId: value.ownerId },
    });
    expect(rawWatermark(value)).toEqual([
      { identity_id: value.ownerId, latest_revision: 2, acknowledged_through: 0 },
    ]);
  });

  it('does not reopen or increment attention for identical or conflicting final retries', () => {
    const value = fixture();
    const prepared = prepare(value, 'request-final-retry');
    value.service.beginSend(prepared.attemptId);
    value.service.settle(prepared.attemptId, 'sent');
    const first = value.service.submitResponse({
      requestId: prepared.requestId,
      attemptId: prepared.attemptId,
      endpoint,
      body: 'first final',
    });
    expect(value.service.acknowledgeExchange(value.ownerId, prepared.requestId, 2)).toMatchObject({
      changed: true,
    });
    expect(
      value.service.submitResponse({
        requestId: prepared.requestId,
        attemptId: prepared.attemptId,
        endpoint,
        body: 'first final',
      })
    ).toEqual(first);
    expect(() =>
      value.service.submitResponse({
        requestId: prepared.requestId,
        attemptId: prepared.attemptId,
        endpoint,
        body: 'conflicting final',
      })
    ).toThrow(expect.objectContaining({ code: 'RESPONSE_CONFLICT' }));
    expect(value.service.listExchanges(value.ownerId).items).toEqual([]);
    expect(rawResponse(value, prepared.requestId)).toMatchObject({ body: 'first final' });
    expect(rawAttempts(value)).toEqual([
      expect.objectContaining({
        request_id: prepared.requestId,
        attention_revision: 2,
        attention_acknowledged_revision: 2,
      }),
    ]);
    expect(rawWatermark(value)).toEqual([
      { identity_id: value.ownerId, latest_revision: 2, acknowledged_through: 0 },
    ]);
  });

  it('does not advance revisions for transport transitions or waiter release', () => {
    const value = fixture();
    const pending = prepare(value, 'request-pending', value.ownerId, { wait: true });
    const sent = prepare(value, 'request-sent', value.ownerId, {
      endpoint: { ...endpoint, paneId: '%sent', panePid: 903 },
      wait: true,
    });
    value.service.beginSend(sent.attemptId);
    value.service.settle(sent.attemptId, 'sent');
    value.service.releaseWait(sent.attemptId);
    const uncertain = prepare(value, 'request-uncertain', value.ownerId, {
      endpoint: { ...endpoint, paneId: '%uncertain', panePid: 904 },
    });
    value.service.beginSend(uncertain.attemptId);
    value.service.settle(uncertain.attemptId, 'uncertain');
    const failed = prepare(value, 'request-failed', value.ownerId, {
      endpoint: { ...endpoint, paneId: '%failed', panePid: 905 },
    });
    value.service.settle(failed.attemptId, 'definitely_failed');
    value.service.cleanup();
    expect(pending.attemptId).not.toBe(uncertain.attemptId);
    expect(
      rawAttempts(value).map((attempt) => [attempt.request_id, attempt.attention_revision])
    ).toEqual([
      ['request-failed', 4],
      ['request-pending', 1],
      ['request-sent', 2],
      ['request-uncertain', 3],
    ]);
    expect(rawWatermark(value)).toEqual([
      { identity_id: value.ownerId, latest_revision: 4, acknowledged_through: 0 },
    ]);
  });

  it('allows pending and failed attention acknowledgement without settling delivery', () => {
    const value = fixture();
    const pending = prepare(value, 'request-pending-ack');
    const failed = prepare(value, 'request-failed-ack');
    value.service.settle(failed.attemptId, 'definitely_failed');
    expect(value.service.acknowledgeExchange(value.ownerId, pending.requestId, 1)).toMatchObject({
      changed: true,
    });
    expect(value.service.acknowledgeExchange(value.ownerId, failed.requestId, 2)).toMatchObject({
      changed: true,
    });
    expect(value.service.showExchange(value.ownerId, pending.requestId)).toMatchObject({
      delivery: 'prepared',
      final: { status: 'not_submitted' },
      acknowledged: true,
      settled: false,
    });
    expect(value.service.showExchange(value.ownerId, failed.requestId)).toMatchObject({
      delivery: 'definitely_failed',
      final: { status: 'not_submitted' },
      acknowledged: true,
      settled: false,
    });
    expect(value.service.listExchanges(value.ownerId).items).toEqual([]);
  });
});
