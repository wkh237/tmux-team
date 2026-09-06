import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createRequestService, type RequestEndpoint } from './request-service.js';
import { openIdentityRepository } from './storage/identity-repository.js';
import {
  collectResults,
  runWorker as spawnWorker,
  stopWorkers,
  waitForFiles,
  workerMessage,
  type WorkerHandle,
} from './test-support/request-workers.js';

const directories: string[] = [];
const NOW_MS = 10_000;
const WORKER_TIMEOUT_MS = 30_000;

const endpoint: RequestEndpoint = {
  serverId: 'attention-server',
  socketPath: '/tmp/attention-server',
  serverPid: 701,
  serverStartTime: 'attention-start',
  paneId: '%attention',
  panePid: 702,
};

interface Fixture {
  readonly directory: string;
  readonly database: string;
  readonly barrier: string;
  readonly identityId: string;
  readonly requestId: string;
  readonly attemptId: string;
}

interface WorkerMessage {
  readonly ok: boolean;
  readonly error?: string;
  readonly code?: string;
  readonly observedRevision?: number;
  readonly result?: unknown;
}

interface RawAttempt {
  readonly request_id: string;
  readonly status: string;
  readonly response_submitted_at_ms: number | null;
  readonly attention_revision: number | null;
  readonly attention_acknowledged_revision: number;
}

interface RawResponse {
  readonly request_id: string;
  readonly body: string;
}

interface RawWatermark {
  readonly identity_id: string;
  readonly latest_revision: number;
  readonly acknowledged_through: number;
}

function fixture(options: { readonly requestId: string; readonly sending: boolean }): Fixture {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-attention-race-'));
  directories.push(directory);
  const barrier = path.join(directory, 'barrier');
  fs.mkdirSync(barrier);
  const database = path.join(directory, 'tmux-team.db');
  const repository = openIdentityRepository(database);
  try {
    const identity = repository.createIdentity('Attention Owner', 'attention-owner');
    const service = createRequestService({ repository, now: () => NOW_MS });
    const prepared = service.prepare({
      requestId: options.requestId,
      message: `baseline message for ${options.requestId}`,
      endpoint,
      wait: true,
      expiresAtMs: NOW_MS + 60_000,
      originator: { kind: 'explicit', identityId: identity.id },
    });
    if (options.sending) service.beginSend(prepared.attemptId);
    return {
      directory,
      database,
      barrier,
      identityId: identity.id,
      requestId: options.requestId,
      attemptId: prepared.attemptId,
    };
  } finally {
    repository.close();
  }
}

function runWorker(
  value: Fixture,
  variant: string,
  mode: string,
  requestId = value.requestId
): WorkerHandle {
  const worker = new URL('./test-support/workers/request-attention-worker.ts', import.meta.url);
  return spawnWorker(
    worker,
    [value.database, value.barrier, value.identityId, requestId, variant, mode],
    variant,
    path.dirname(value.barrier)
  );
}

async function startWorkers(value: Fixture, handles: readonly WorkerHandle[]): Promise<void> {
  await waitForFiles(
    handles.map((handle) => path.join(value.barrier, `ready-${handle.variant}`)),
    handles
  );
  fs.writeFileSync(path.join(value.barrier, 'go'), 'go');
}

async function finishWorkers(
  value: Fixture,
  handles: readonly WorkerHandle[]
): Promise<WorkerMessage[]> {
  try {
    const results = await collectResults(handles, WORKER_TIMEOUT_MS);
    return results.map((result) => workerMessage<WorkerMessage>(result));
  } finally {
    await stopWorkers(handles);
  }
}

function rawState(databaseFile: string): {
  attempts: RawAttempt[];
  responses: RawResponse[];
  watermarks: RawWatermark[];
} {
  const database = new Database(databaseFile, { readonly: true });
  try {
    return {
      attempts: database
        .prepare(
          `SELECT request_id, status, response_submitted_at_ms,
                  attention_revision, attention_acknowledged_revision
           FROM request_attempts ORDER BY request_id`
        )
        .all() as RawAttempt[],
      responses: database
        .prepare('SELECT request_id, body FROM request_responses ORDER BY request_id')
        .all() as RawResponse[],
      watermarks: database
        .prepare(
          'SELECT identity_id, latest_revision, acknowledged_through FROM request_attention_identities ORDER BY identity_id'
        )
        .all() as RawWatermark[],
    };
  } finally {
    database.close();
  }
}

function unacknowledgedRequestIds(value: Fixture): string[] {
  const repository = openIdentityRepository(value.database);
  try {
    const service = createRequestService({ repository, now: () => NOW_MS });
    const listing = service.listExchanges(value.identityId, { limit: 100 });
    return listing.items
      .filter((exchange) => !exchange.acknowledged)
      .map((exchange) => exchange.requestId)
      .sort();
  } finally {
    repository.close();
  }
}

async function runSingleAckRace(value: Fixture, finalFirst: boolean): Promise<WorkerMessage[]> {
  const ack = runWorker(value, 'ack', 'single-ack');
  const final = runWorker(value, 'final', 'final');
  const handles = [ack, final];
  try {
    await startWorkers(value, handles);
    await waitForFiles([path.join(value.barrier, 'observed-ack')], handles);

    if (finalFirst) {
      fs.writeFileSync(path.join(value.barrier, 'release-final'), 'release');
      await waitForFiles([path.join(value.barrier, 'done-final')], handles);
      fs.writeFileSync(path.join(value.barrier, 'proceed-ack'), 'proceed');
      await waitForFiles([path.join(value.barrier, 'tx-enter-ack')], handles);
      fs.writeFileSync(path.join(value.barrier, 'release-ack'), 'release');
    } else {
      fs.writeFileSync(path.join(value.barrier, 'proceed-ack'), 'proceed');
      await waitForFiles([path.join(value.barrier, 'tx-enter-ack')], handles);
      fs.writeFileSync(path.join(value.barrier, 'release-ack'), 'release');
      await waitForFiles([path.join(value.barrier, 'done-ack')], handles);
      fs.writeFileSync(path.join(value.barrier, 'release-final'), 'release');
    }

    await waitForFiles([path.join(value.barrier, 'done-ack')], handles);
    await waitForFiles([path.join(value.barrier, 'done-final')], handles);
    return await finishWorkers(value, handles);
  } catch (error) {
    await stopWorkers(handles);
    throw error;
  }
}

async function runAckAllRace(
  value: Fixture,
  mode: 'final' | 'new-request',
  finalFirst: boolean
): Promise<WorkerMessage[]> {
  // The ack-all operation receives no request token at all. The placeholder is
  // only the worker's positional argument and is never read in that mode.
  const ackAll = runWorker(value, 'ack-all', 'ack-all', '-');
  const concurrent = runWorker(
    value,
    'concurrent',
    mode,
    mode === 'new-request' ? '-' : value.requestId
  );
  const handles = [ackAll, concurrent];
  try {
    await startWorkers(value, handles);
    await waitForFiles(
      handles.map((handle) => path.join(value.barrier, `tx-enter-${handle.variant}`)),
      handles
    );

    const first = finalFirst ? concurrent : ackAll;
    const second = finalFirst ? ackAll : concurrent;
    fs.writeFileSync(path.join(value.barrier, `release-${first.variant}`), 'release');
    await waitForFiles([path.join(value.barrier, `done-${first.variant}`)], handles);
    fs.writeFileSync(path.join(value.barrier, `release-${second.variant}`), 'release');
    await waitForFiles([path.join(value.barrier, `done-${second.variant}`)], handles);
    return await finishWorkers(value, handles);
  } catch (error) {
    await stopWorkers(handles);
    throw error;
  }
}

async function runAckAllFailure(value: Fixture): Promise<WorkerMessage[]> {
  const worker = runWorker(value, 'ack-fail', 'ack-all-fail', '-');
  try {
    await startWorkers(value, [worker]);
    await waitForFiles([path.join(value.barrier, 'tx-enter-ack-fail')], [worker]);
    fs.writeFileSync(path.join(value.barrier, 'release-ack-fail'), 'release');
    await waitForFiles([path.join(value.barrier, 'done-ack-fail')], [worker]);
    return await finishWorkers(value, [worker]);
  } catch (error) {
    await stopWorkers([worker]);
    throw error;
  }
}

function expectRawFinal(
  value: Fixture,
  expectedRequestIds: readonly string[],
  expectedBody: string,
  expectedAcknowledgedRevision: number,
  expectedAcknowledgedThrough: number
): void {
  const state = rawState(value.database);
  expect(state.attempts.map((attempt) => attempt.request_id).sort()).toEqual(
    [...expectedRequestIds].sort()
  );
  expect(state.attempts.every((attempt) => attempt.status === 'sending')).toBe(true);
  expect(state.attempts.every((attempt) => attempt.response_submitted_at_ms !== null)).toBe(true);
  expect(state.attempts[0]?.attention_revision).toBe(2);
  expect(state.attempts[0]?.attention_acknowledged_revision).toBe(expectedAcknowledgedRevision);
  expect(state.responses).toHaveLength(1);
  expect(state.responses[0]?.request_id).toBe(value.requestId);
  expect(state.responses[0]?.body).toBe(expectedBody);
  expect(state.watermarks).toEqual([
    {
      identity_id: value.identityId,
      latest_revision: 2,
      acknowledged_through: expectedAcknowledgedThrough,
    },
  ]);
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('request attention multi-process races', () => {
  it.each([
    ['ack commits before the first final', false],
    ['the first final commits before the stale ack', true],
  ])(
    '%s keeps a later final unacknowledged',
    async (_label, finalFirst) => {
      const value = fixture({ requestId: 'request-single-ack', sending: true });
      const messages = await runSingleAckRace(value, finalFirst);

      expect(messages).toHaveLength(2);
      expect(messages[1]?.ok).toBe(true);
      expect(messages[0]?.observedRevision).toBe(1);
      if (!finalFirst) {
        expect(messages[0]?.ok).toBe(true);
        expect((messages[0]?.result as { changed?: boolean } | undefined)?.changed).toBe(true);
        expectRawFinal(value, [value.requestId], 'final response from final', 1, 0);
      } else {
        expect(messages[0]?.ok).toBe(false);
        expect(messages[0]?.code).toBe('X_REVISION_CONFLICT');
        expectRawFinal(value, [value.requestId], 'final response from final', 0, 0);
      }
      expect(unacknowledgedRequestIds(value)).toEqual([value.requestId]);
    },
    WORKER_TIMEOUT_MS
  );

  it.each([
    ['ack-all commits before a final', false],
    ['the final commits before ack-all', true],
  ])(
    '%s acknowledges one atomic snapshot',
    async (_label, finalFirst) => {
      const value = fixture({ requestId: 'request-ack-all-final', sending: true });
      const messages = await runAckAllRace(value, 'final', finalFirst);

      expect(messages.every((message) => message.ok)).toBe(true);
      expectRawFinal(
        value,
        [value.requestId],
        'final response from concurrent',
        0,
        finalFirst ? 2 : 1
      );
      expect(unacknowledgedRequestIds(value)).toEqual(finalFirst ? [] : [value.requestId]);
    },
    WORKER_TIMEOUT_MS
  );

  it.each([
    ['ack-all commits before a new request', false],
    ['the new request commits before ack-all', true],
  ])(
    '%s does not acknowledge a concurrently prepared request',
    async (_label, newFirst) => {
      const value = fixture({ requestId: 'request-ack-all-new', sending: false });
      const messages = await runAckAllRace(value, 'new-request', newFirst);

      expect(messages.every((message) => message.ok)).toBe(true);
      const newRequestId = 'request-concurrent';
      const state = rawState(value.database);
      expect(state.attempts.map((attempt) => attempt.request_id).sort()).toEqual(
        [value.requestId, newRequestId].sort()
      );
      expect(
        state.attempts.map((attempt) => ({
          request_id: attempt.request_id,
          attention_revision: attempt.attention_revision,
          attention_acknowledged_revision: attempt.attention_acknowledged_revision,
        }))
      ).toEqual([
        {
          request_id: value.requestId,
          attention_revision: 1,
          attention_acknowledged_revision: 0,
        },
        {
          request_id: newRequestId,
          attention_revision: 2,
          attention_acknowledged_revision: 0,
        },
      ]);
      expect(state.watermarks).toEqual([
        {
          identity_id: value.identityId,
          latest_revision: 2,
          acknowledged_through: newFirst ? 2 : 1,
        },
      ]);
      expect(state.responses).toHaveLength(0);
      expect(unacknowledgedRequestIds(value)).toEqual(newFirst ? [] : [newRequestId]);
    },
    WORKER_TIMEOUT_MS
  );

  it(
    'rolls back an ack-all failure without advancing the durable watermark',
    async () => {
      const value = fixture({ requestId: 'request-ack-rollback', sending: false });
      const messages = await runAckAllFailure(value);

      expect(messages).toEqual([
        expect.objectContaining({ ok: false, error: expect.stringContaining('injected') }),
      ]);
      const state = rawState(value.database);
      expect(state.attempts).toEqual([
        expect.objectContaining({
          request_id: value.requestId,
          attention_revision: 1,
          attention_acknowledged_revision: 0,
        }),
      ]);
      expect(state.watermarks).toEqual([
        {
          identity_id: value.identityId,
          latest_revision: 1,
          acknowledged_through: 0,
        },
      ]);
      expect(unacknowledgedRequestIds(value)).toEqual([value.requestId]);
    },
    WORKER_TIMEOUT_MS
  );
});
