import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EXCHANGE_METADATA_SETTLEMENT_FLOOR_MS,
  EXCHANGE_RESPONSE_ACCEPTANCE_WINDOW_MS,
  LEGACY_EXCHANGE_RETENTION_DAYS,
  RETENTION_DAY_MS,
} from '../domain/exchange-retention.js';
import { createRequestService, type RequestEndpoint } from '../request-service.js';
import { StorageError } from './errors.js';
import { openIdentityRepository } from './identity-repository.js';
import { CURRENT_MIGRATIONS } from './migrations.js';
import { openStorageWithMigrations } from './sqlite-adapter.js';

const directories: string[] = [];
const repositories: Array<{ close(): void }> = [];

const identity = {
  id: 'identity-1',
  name: 'Migrated',
  canonicalName: 'migrated',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

const endpoint: RequestEndpoint = {
  serverId: 'server-1',
  socketPath: '/tmp/tmt-server-1',
  serverPid: 101,
  serverStartTime: 'server-start-1',
  paneId: '%7',
  panePid: 202,
};

const preparedAtMs = 1_700_000_000_000;
const nowMs = preparedAtMs + 100;
const responseBody = 'response from a migrated attempt';

function databaseFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-response-migration-'));
  directories.push(directory);
  return path.join(directory, 'tmux-team.db');
}

function location(file: string): { globalDir: string; databaseFile: string } {
  return { globalDir: path.dirname(file), databaseFile: file };
}

function seedSchema4Database(file: string): void {
  const initial = openStorageWithMigrations(location(file), CURRENT_MIGRATIONS.slice(0, 4));
  initial.close();

  const database = new Database(file);
  try {
    database
      .prepare(
        'INSERT INTO identities (id, name, canonical_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(
        identity.id,
        identity.name,
        identity.canonicalName,
        identity.createdAt,
        identity.updatedAt
      );
    database
      .prepare(
        'INSERT INTO bindings (id, identity_id, transport, pane_id, server_id, socket_path, server_pid, server_start_time, pane_pid, bound_at, last_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        'binding-1',
        identity.id,
        'tmux',
        endpoint.paneId,
        endpoint.serverId,
        endpoint.socketPath,
        endpoint.serverPid,
        endpoint.serverStartTime,
        endpoint.panePid,
        '2026-01-02T00:00:00.000Z',
        '2026-01-02T00:00:01.000Z'
      );
    database
      .prepare('INSERT INTO role_profiles (identity_id, content, updated_at) VALUES (?, ?, ?)')
      .run(identity.id, 'role survives migration', '2026-01-02T00:00:02.000Z');
    database
      .prepare('INSERT INTO identity_preambles (identity_id, content, updated_at) VALUES (?, ?, ?)')
      .run(identity.id, 'preamble survives migration', '2026-01-02T00:00:03.000Z');
    database
      .prepare(
        'INSERT INTO preamble_counters (identity_id, reserved_count, updated_at_ms) VALUES (?, ?, ?)'
      )
      .run(identity.id, 7, preparedAtMs - 1);
    database
      .prepare(
        `INSERT INTO request_attempts (
           attempt_id, request_id, nonce, identity_id, server_id, socket_path, server_pid,
           server_start_time, pane_id, pane_pid, wait_active, status, preamble_every,
           inject_preamble, cadence_reserved, prepared_at_ms, sending_at_ms, settled_at_ms,
           wait_released_at_ms, expires_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'attempt-1',
        'request-1',
        'nonce-1',
        identity.id,
        endpoint.serverId,
        endpoint.socketPath,
        endpoint.serverPid,
        endpoint.serverStartTime,
        endpoint.paneId,
        endpoint.panePid,
        0,
        'sent',
        3,
        1,
        1,
        preparedAtMs,
        preparedAtMs + 10,
        preparedAtMs + 20,
        preparedAtMs + 30,
        preparedAtMs + 60 * 60 * 1000
      );
  } finally {
    database.close();
  }
}

type HistoricalRequestRow = {
  attemptId: string;
  requestId: string;
  preparedAtMs: number;
  expiresAtMs: number;
  settledAtMs: number;
  submittedAtMs?: number;
};

function seedSchema5Requests(file: string, rows: readonly HistoricalRequestRow[]): void {
  const initial = openStorageWithMigrations(location(file), CURRENT_MIGRATIONS.slice(0, 5));
  initial.close();

  const database = new Database(file);
  try {
    const insertAttempt = database.prepare(
      `INSERT INTO request_attempts (
         attempt_id, request_id, nonce, identity_id, server_id, socket_path, server_pid,
         server_start_time, pane_id, pane_pid, wait_active, status, preamble_every,
         inject_preamble, cadence_reserved, prepared_at_ms, sending_at_ms, settled_at_ms,
         wait_released_at_ms, response_submitted_at_ms, expires_at_ms
       ) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, 0, 'sent', NULL, 0, 0, ?, ?, ?, ?, ?, ?)`
    );
    const insertResponse = database.prepare(
      `INSERT INTO request_responses (
         request_id, attempt_id, server_id, socket_path, server_pid, server_start_time,
         pane_id, pane_pid, body, body_bytes, submitted_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    database.transaction(() => {
      for (const row of rows) {
        insertAttempt.run(
          row.attemptId,
          row.requestId,
          endpoint.serverId,
          endpoint.socketPath,
          endpoint.serverPid,
          endpoint.serverStartTime,
          endpoint.paneId,
          endpoint.panePid,
          row.preparedAtMs,
          row.preparedAtMs,
          row.settledAtMs,
          null,
          row.submittedAtMs ?? null,
          row.expiresAtMs
        );
        if (row.submittedAtMs !== undefined) {
          const body = `body-${row.requestId}`;
          insertResponse.run(
            row.requestId,
            row.attemptId,
            endpoint.serverId,
            endpoint.socketPath,
            endpoint.serverPid,
            endpoint.serverStartTime,
            endpoint.paneId,
            endpoint.panePid,
            body,
            Buffer.byteLength(body, 'utf8'),
            row.submittedAtMs
          );
        }
      }
    })();
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

describe('request response migrations', () => {
  it('upgrades schema 4 SQLite state without losing request data and reopens idempotently', () => {
    const file = databaseFile();
    seedSchema4Database(file);

    const repository = openIdentityRepository(file);
    repositories.push(repository);
    const service = createRequestService({ repository, now: () => nowMs });

    expect(repository.findByCanonicalName(identity.canonicalName)).toEqual(identity);
    expect(repository.findBindings()).toEqual([
      {
        id: 'binding-1',
        identityId: identity.id,
        transport: 'tmux',
        ...endpoint,
        boundAt: '2026-01-02T00:00:00.000Z',
        lastVerifiedAt: '2026-01-02T00:00:01.000Z',
      },
    ]);
    expect(repository.findRole(identity.id)).toEqual({
      content: 'role survives migration',
      updatedAt: '2026-01-02T00:00:02.000Z',
    });
    expect(repository.findPreamble(identity.id)).toEqual({
      content: 'preamble survives migration',
      updatedAt: '2026-01-02T00:00:03.000Z',
    });
    expect(repository.getPreambleCount(identity.id)).toBe(7);

    const migratedAttempt = repository.findAttempt('attempt-1');
    expect(migratedAttempt).toEqual({
      ...endpoint,
      attemptId: 'attempt-1',
      requestId: 'request-1',
      originator: { kind: 'unknown' },
      nonce: 'nonce-1',
      identityId: identity.id,
      waitActive: false,
      status: 'sent',
      preambleEvery: 3,
      injectPreamble: true,
      cadenceReserved: true,
      preparedAtMs,
      sendingAtMs: preparedAtMs + 10,
      settledAtMs: preparedAtMs + 20,
      waitReleasedAtMs: preparedAtMs + 30,
      expiresAtMs: preparedAtMs + 60 * 60 * 1000,
      retentionDays: 7,
      retentionExpiresAtMs: preparedAtMs + 7 * 24 * 60 * 60 * 1000,
    });

    const beforeResponse = new Database(file, { readonly: true });
    try {
      expect(
        beforeResponse
          .prepare('SELECT response_submitted_at_ms FROM request_attempts WHERE request_id = ?')
          .get('request-1')
      ).toEqual({ response_submitted_at_ms: null });
    } finally {
      beforeResponse.close();
    }

    const response = service.submitResponse({
      requestId: 'request-1',
      attemptId: 'attempt-1',
      endpoint,
      body: responseBody,
    });
    expect(response).toEqual({
      requestId: 'request-1',
      attemptId: 'attempt-1',
      endpoint,
      body: responseBody,
      bodyBytes: Buffer.byteLength(responseBody, 'utf8'),
      submittedAtMs: nowMs,
      responseExpiresAtMs: nowMs + 7 * 24 * 60 * 60 * 1000,
    });
    expect(service.getResponse('request-1')).toEqual(response);
    expect(repository.findAttempt('attempt-1')).toMatchObject({
      responseSubmittedAtMs: nowMs,
    });
    expect(service.getRequestContext('request-1')?.prompt).toEqual({ status: 'unavailable' });
    repository.close();

    const reopened = openIdentityRepository(file);
    repositories.push(reopened);
    const reopenedService = createRequestService({ repository: reopened, now: () => nowMs });
    expect(reopenedService.getResponse('request-1')).toEqual(response);
    expect(
      reopenedService.submitResponse({
        requestId: 'request-1',
        attemptId: 'attempt-1',
        endpoint,
        body: responseBody,
      })
    ).toEqual(response);
    reopened.close();

    const verification = new Database(file, { readonly: true });
    try {
      expect(verification.prepare('SELECT MAX(version) AS version FROM _migrations').get()).toEqual(
        { version: CURRENT_MIGRATIONS.length }
      );
      expect(
        verification.prepare('SELECT version, name FROM _migrations ORDER BY version').all()
      ).toEqual(
        CURRENT_MIGRATIONS.map((migration) => ({
          version: migration.version,
          name: migration.name,
        }))
      );
      expect(verification.prepare('SELECT COUNT(*) AS count FROM request_responses').get()).toEqual(
        {
          count: 1,
        }
      );
      expect(
        verification
          .prepare('SELECT response_submitted_at_ms FROM request_attempts WHERE request_id = ?')
          .get('request-1')
      ).toEqual({ response_submitted_at_ms: nowMs });
    } finally {
      verification.close();
    }
  });

  it('backfills multiple keyset pages from original request and response anchors', () => {
    const file = databaseFile();
    const rows = Array.from({ length: 205 }, (_, index) => {
      const anchor = preparedAtMs + index * 10_000;
      return {
        attemptId: `attempt-${String(index).padStart(3, '0')}`,
        requestId: `request-${String(index).padStart(3, '0')}`,
        preparedAtMs: anchor,
        expiresAtMs: anchor + 10,
        settledAtMs: anchor + 20,
        submittedAtMs: anchor + 30,
      };
    });
    const unansweredAttempt = {
      attemptId: 'attempt-no-response',
      requestId: 'request-no-response',
      preparedAtMs: preparedAtMs + 3_000_000,
      expiresAtMs: preparedAtMs + 3_000_010,
      settledAtMs: preparedAtMs + 3_000_020,
    };
    seedSchema5Requests(file, [...rows, unansweredAttempt]);

    const repository = openIdentityRepository(file);
    repositories.push(repository);
    const expected = (row: HistoricalRequestRow): number => {
      const frozen = row.preparedAtMs + LEGACY_EXCHANGE_RETENTION_DAYS * RETENTION_DAY_MS;
      const acceptance = row.preparedAtMs + EXCHANGE_RESPONSE_ACCEPTANCE_WINDOW_MS;
      const settlement = row.expiresAtMs + EXCHANGE_METADATA_SETTLEMENT_FLOOR_MS;
      const settled = row.settledAtMs + EXCHANGE_METADATA_SETTLEMENT_FLOOR_MS;
      const response =
        row.submittedAtMs === undefined
          ? 0
          : row.submittedAtMs + LEGACY_EXCHANGE_RETENTION_DAYS * RETENTION_DAY_MS;
      return Math.max(frozen, acceptance, settlement, settled, response);
    };

    const verification = new Database(file, { readonly: true });
    try {
      expect(verification.prepare('SELECT COUNT(*) AS count FROM request_attempts').get()).toEqual({
        count: 206,
      });
      expect(verification.prepare('SELECT COUNT(*) AS count FROM request_responses').get()).toEqual(
        {
          count: 205,
        }
      );
      expect(
        verification
          .prepare('SELECT COUNT(*) AS count FROM request_attempts WHERE retention_days = 7')
          .get()
      ).toEqual({ count: 206 });
    } finally {
      verification.close();
    }

    for (const index of [0, 99, 100, 204]) {
      const row = rows[index]!;
      expect(repository.findAttempt(row.attemptId)).toMatchObject({
        retentionDays: LEGACY_EXCHANGE_RETENTION_DAYS,
        retentionExpiresAtMs: expected(row),
      });
      expect(repository.findResponse(row.requestId)).toMatchObject({
        responseExpiresAtMs: row.submittedAtMs! + LEGACY_EXCHANGE_RETENTION_DAYS * RETENTION_DAY_MS,
      });
    }
    expect(repository.findAttempt(unansweredAttempt.attemptId)).toMatchObject({
      retentionDays: LEGACY_EXCHANGE_RETENTION_DAYS,
      retentionExpiresAtMs: expected(unansweredAttempt),
    });
  });

  it('adds provenance and prompt columns from schema 6 without changing historical rows', () => {
    const file = databaseFile();
    seedSchema5Requests(file, [
      {
        attemptId: 'schema6-attempt',
        requestId: 'schema6-request',
        preparedAtMs,
        expiresAtMs: preparedAtMs + 60 * 60 * 1000,
        settledAtMs: preparedAtMs + 20,
        submittedAtMs: preparedAtMs + 30,
      },
    ]);
    const schema6 = openStorageWithMigrations(location(file), CURRENT_MIGRATIONS.slice(0, 6));
    schema6.close();

    const repository = openIdentityRepository(file);
    repositories.push(repository);
    expect(repository.findAttempt('schema6-attempt')).toMatchObject({
      originator: { kind: 'unknown' },
      retentionDays: LEGACY_EXCHANGE_RETENTION_DAYS,
    });
    expect(repository.findResponse('schema6-request')).toMatchObject({
      responseExpiresAtMs: preparedAtMs + 30 + LEGACY_EXCHANGE_RETENTION_DAYS * RETENTION_DAY_MS,
    });
    expect(repository.findRequestContext('schema6-request')).not.toHaveProperty('promptMessage');
    expect(repository.findRequestContext('schema6-request')).not.toHaveProperty(
      'promptMessageBytes'
    );
  });

  it('bounds migration arithmetic for valid historical timestamps near MAX_SAFE_INTEGER', () => {
    const file = databaseFile();
    const nearMax = Number.MAX_SAFE_INTEGER - 1;
    seedSchema5Requests(file, [
      {
        attemptId: 'near-max-attempt',
        requestId: 'near-max-request',
        preparedAtMs: nearMax,
        expiresAtMs: nearMax,
        settledAtMs: nearMax,
        submittedAtMs: nearMax,
      },
    ]);

    const repository = openIdentityRepository(file);
    repositories.push(repository);
    expect(repository.findAttempt('near-max-attempt')).toMatchObject({
      retentionDays: 7,
      retentionExpiresAtMs: Number.MAX_SAFE_INTEGER,
    });
    expect(repository.findResponse('near-max-request')).toMatchObject({
      responseExpiresAtMs: Number.MAX_SAFE_INTEGER,
    });
  });

  it('rolls back invalid historical retention values without partial schema changes', () => {
    const file = databaseFile();
    seedSchema5Requests(file, [
      {
        attemptId: 'invalid-attempt',
        requestId: 'invalid-request',
        preparedAtMs: 0,
        expiresAtMs: preparedAtMs,
        settledAtMs: preparedAtMs,
      },
    ]);

    expect(() => openIdentityRepository(file)).toThrow(StorageError);
    try {
      openIdentityRepository(file);
      expect.fail('expected migration 6 to reject the invalid historical anchor');
    } catch (error) {
      expect(error).toMatchObject({ code: 'migration', migrationVersion: 6 });
    }

    const failed = new Database(file, { readonly: true });
    try {
      expect(failed.prepare('SELECT MAX(version) AS version FROM _migrations').get()).toEqual({
        version: 5,
      });
      expect(failed.pragma('table_info(request_attempts)')).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'retention_days' })])
      );
      expect(
        failed
          .prepare('SELECT prepared_at_ms FROM request_attempts WHERE attempt_id = ?')
          .get('invalid-attempt')
      ).toEqual({ prepared_at_ms: 0 });
    } finally {
      failed.close();
    }

    const repair = new Database(file);
    try {
      repair
        .prepare('UPDATE request_attempts SET prepared_at_ms = ? WHERE attempt_id = ?')
        .run(preparedAtMs, 'invalid-attempt');
    } finally {
      repair.close();
    }
    const recovered = openIdentityRepository(file);
    repositories.push(recovered);
    expect(recovered.findAttempt('invalid-attempt')).toMatchObject({
      retentionDays: LEGACY_EXCHANGE_RETENTION_DAYS,
      retentionExpiresAtMs: Math.max(
        preparedAtMs + LEGACY_EXCHANGE_RETENTION_DAYS * RETENTION_DAY_MS,
        preparedAtMs + EXCHANGE_RESPONSE_ACCEPTANCE_WINDOW_MS,
        preparedAtMs + EXCHANGE_METADATA_SETTLEMENT_FLOOR_MS
      ),
    });
  });
});
