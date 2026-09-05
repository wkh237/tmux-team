import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRequestService,
  type RequestEndpoint,
  type RequestService,
} from './request-service.js';
import { openIdentityRepository, type IdentityRepository } from './storage/identity-repository.js';
import {
  collectResults,
  runWorker as spawnWorker,
  stopWorkers,
  waitForFiles,
  workerMessage,
  type WorkerHandle,
} from './test-support/request-workers.js';

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

interface RaceFixture {
  readonly database: string;
  readonly barrier: string;
  readonly identityId: string;
  readonly repository: IdentityRepository;
  readonly service: RequestService;
}

interface WorkerMessage {
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
  readonly response?: unknown;
  readonly attempt?: {
    readonly status: string;
    readonly cadenceReserved: boolean;
  };
  readonly cadence?: boolean;
}

function raceFixture(): RaceFixture {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-response-race-'));
  directories.push(directory);
  const barrier = path.join(directory, 'barrier');
  fs.mkdirSync(barrier);
  const database = path.join(directory, 'tmux-team.db');
  const repository = openIdentityRepository(database);
  repositories.push(repository);
  const identity = repository.createIdentity('Alice', 'alice');
  const service = createRequestService({ repository, now: () => 1_700_000_000_000 });
  return { database, barrier, identityId: identity.id, repository, service };
}

function prepareSending(value: RaceFixture, requestId: string): string {
  const prepared = value.service.prepare({
    requestId,
    endpoint,
    wait: true,
    expiresAtMs: 1_700_000_000_000 + 60 * 60 * 1000,
    preamble: { identityId: value.identityId, every: 3 },
  });
  value.service.beginSend(prepared.attemptId);
  return prepared.attemptId;
}

function runWorker(
  value: RaceFixture,
  requestId: string,
  attemptId: string,
  variant: string,
  mode: string,
  body?: string
): WorkerHandle {
  const worker = path.join(process.cwd(), 'src/request-response-concurrency-worker.ts');
  return spawnWorker(
    worker,
    [
      value.database,
      value.barrier,
      requestId,
      attemptId,
      variant,
      mode,
      ...(body === undefined ? [] : [body]),
    ],
    variant,
    process.cwd()
  );
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('durable response multi-process races', () => {
  it('makes identical concurrent submissions idempotent and preserves cadence state', async () => {
    const value = raceFixture();
    const requestId = 'request-identical-race';
    const attemptId = prepareSending(value, requestId);
    const handles = ['a', 'b'].map((variant) =>
      runWorker(value, requestId, attemptId, variant, 'submit', 'same body')
    );
    try {
      await waitForFiles(
        handles.map((handle) => path.join(value.barrier, `ready-${handle.variant}`)),
        handles
      );
      fs.writeFileSync(path.join(value.barrier, 'go'), 'go');
      const messages = (await collectResults(handles)).map((result) =>
        workerMessage<WorkerMessage>(result)
      );
      expect(messages.every((item) => item.ok)).toBe(true);
      expect(messages.every((item) => item.attempt?.status === 'sending')).toBe(true);
      expect(messages.every((item) => item.cadence === true)).toBe(true);
      expect(value.service.getResponse(requestId)).toMatchObject({
        requestId,
        attemptId,
        body: 'same body',
        bodyBytes: Buffer.byteLength('same body', 'utf8'),
      });
      expect(value.repository.getPreambleCount(value.identityId)).toBe(1);
    } finally {
      await stopWorkers(handles);
    }
  }, 30_000);

  it('serializes conflicting concurrent submissions and keeps the winning persisted body', async () => {
    const value = raceFixture();
    const requestId = 'request-conflict-race';
    const attemptId = prepareSending(value, requestId);
    const handles = [
      runWorker(value, requestId, attemptId, 'left', 'submit', 'left body'),
      runWorker(value, requestId, attemptId, 'right', 'submit', 'right body'),
    ];
    try {
      await waitForFiles(
        handles.map((handle) => path.join(value.barrier, `ready-${handle.variant}`)),
        handles
      );
      fs.writeFileSync(path.join(value.barrier, 'go'), 'go');
      const messages = (await collectResults(handles)).map((result) =>
        workerMessage<WorkerMessage>(result)
      );
      expect(messages.filter((item) => item.ok)).toHaveLength(1);
      expect(messages.filter((item) => item.code === 'RESPONSE_CONFLICT')).toHaveLength(1);
      const winner = messages.find((item) => item.ok)?.response as { body: string } | undefined;
      expect(winner?.body === 'left body' || winner?.body === 'right body').toBe(true);
      expect(value.service.getResponse(requestId)?.body).toBe(winner?.body);
      expect(value.repository.getPreambleCount(value.identityId)).toBe(1);
    } finally {
      await stopWorkers(handles);
    }
  }, 30_000);

  it('handles finalization-before-failure and failure-before-finalization in independent processes', async () => {
    const finalFirst = raceFixture();
    const finalFirstRequest = 'request-final-first';
    const finalFirstAttempt = prepareSending(finalFirst, finalFirstRequest);
    const finalWorker = runWorker(
      finalFirst,
      finalFirstRequest,
      finalFirstAttempt,
      'final',
      'submit-gated',
      'final body'
    );
    const failureWorker = runWorker(
      finalFirst,
      finalFirstRequest,
      finalFirstAttempt,
      'failure',
      'fail-gated'
    );
    const handles = [finalWorker, failureWorker];
    try {
      await waitForFiles(
        handles.map((handle) => path.join(finalFirst.barrier, `ready-${handle.variant}`)),
        handles
      );
      fs.writeFileSync(path.join(finalFirst.barrier, 'go-submit'), 'go');
      const [submitted] = await collectResults([finalWorker]);
      const submittedMessage = workerMessage<WorkerMessage>(submitted);
      expect(submittedMessage.ok).toBe(true);
      fs.writeFileSync(path.join(finalFirst.barrier, 'go-fail'), 'go');
      const [settledResult] = await collectResults([failureWorker]);
      const settled = workerMessage<WorkerMessage>(settledResult);
      expect(settled).toMatchObject({ ok: true, attempt: { status: 'uncertain' }, cadence: true });
      expect(finalFirst.service.getResponse(finalFirstRequest)?.body).toBe('final body');
      expect(finalFirst.repository.getPreambleCount(finalFirst.identityId)).toBe(1);
    } finally {
      await stopWorkers(handles);
    }

    const failureFirst = raceFixture();
    const failureFirstRequest = 'request-failure-first';
    const failureFirstAttempt = prepareSending(failureFirst, failureFirstRequest);
    const firstFailureWorker = runWorker(
      failureFirst,
      failureFirstRequest,
      failureFirstAttempt,
      'failure',
      'fail-gated'
    );
    const lateFinalWorker = runWorker(
      failureFirst,
      failureFirstRequest,
      failureFirstAttempt,
      'final',
      'submit-gated',
      'late body'
    );
    const secondHandles = [firstFailureWorker, lateFinalWorker];
    try {
      await waitForFiles(
        secondHandles.map((handle) => path.join(failureFirst.barrier, `ready-${handle.variant}`)),
        secondHandles
      );
      fs.writeFileSync(path.join(failureFirst.barrier, 'go-fail'), 'go');
      const [failedResult] = await collectResults([firstFailureWorker]);
      const failed = workerMessage<WorkerMessage>(failedResult);
      expect(failed).toMatchObject({
        ok: true,
        attempt: { status: 'definitely_failed' },
        cadence: false,
      });
      fs.writeFileSync(path.join(failureFirst.barrier, 'go-submit'), 'go');
      const [rejectedResult] = await collectResults([lateFinalWorker]);
      const rejected = workerMessage<WorkerMessage>(rejectedResult);
      expect(rejected).toMatchObject({ ok: false, code: 'RESPONSE_STATE_INVALID' });
      expect(failureFirst.service.getResponse(failureFirstRequest)).toBeUndefined();
      expect(failureFirst.repository.getPreambleCount(failureFirst.identityId)).toBe(0);
    } finally {
      await stopWorkers(secondHandles);
    }
  }, 60_000);
});
