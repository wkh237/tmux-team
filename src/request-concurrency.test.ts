import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RequestAttemptRecord, RequestPreparation } from './request-service.js';
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

interface WorkerMessage {
  readonly ok: boolean;
  readonly error?: string;
  readonly prepared?: RequestPreparation;
  readonly attempt?: RequestAttemptRecord;
}

function databaseFixture(): {
  directory: string;
  database: string;
  barrier: string;
  identity: string;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-request-race-'));
  directories.push(directory);
  const barrier = path.join(directory, 'barrier');
  fs.mkdirSync(barrier);
  const database = path.join(directory, 'tmux-team.db');
  const repository = openIdentityRepository(database);
  try {
    const identity = repository.createIdentity('Alice', 'alice');
    return { directory, database, barrier, identity: identity.id };
  } finally {
    repository.close();
  }
}

function runWorker(
  database: string,
  barrier: string,
  identity: string,
  variant: string,
  mode = 'prepare'
): WorkerHandle {
  const worker = path.join(process.cwd(), 'src/request-concurrency-worker.ts');
  return spawnWorker(worker, [database, barrier, identity, variant, mode], variant, process.cwd());
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('request service multi-process races', () => {
  it('serializes same-identity cadence reservations without losing attempts or injections', async () => {
    const fixture = databaseFixture();
    const variants = Array.from({ length: 8 }, (_, index) => `same-${index}`);
    const handles = variants.map((variant) =>
      runWorker(fixture.database, fixture.barrier, fixture.identity, variant)
    );
    try {
      await waitForFiles(
        variants.map((variant) => path.join(fixture.barrier, `ready-${variant}`)),
        handles
      );
      fs.writeFileSync(path.join(fixture.barrier, 'go'), 'go');
      const results = await collectResults(handles);
      const messages = results.map((result) => workerMessage<WorkerMessage>(result));
      expect(messages.every((message) => message.ok)).toBe(true);

      const repository = openIdentityRepository(fixture.database);
      try {
        const attempts = repository.listAttempts();
        expect(attempts).toHaveLength(variants.length);
        expect(new Set(attempts.map((attempt) => attempt.attemptId)).size).toBe(variants.length);
        expect(new Set(attempts.map((attempt) => attempt.requestId)).size).toBe(variants.length);
        expect(attempts.every((attempt) => attempt.identityId === fixture.identity)).toBe(true);
        expect(attempts.every((attempt) => attempt.waitActive)).toBe(true);
        expect(attempts.filter((attempt) => attempt.injectPreamble)).toHaveLength(
          Math.ceil(variants.length / 3)
        );
        expect(repository.getPreambleCount(fixture.identity)).toBe(variants.length);
      } finally {
        repository.close();
      }
    } finally {
      await stopWorkers(handles);
    }
  }, 15_000);

  it('keeps same-pane waits independent when server endpoint evidence differs', async () => {
    const fixture = databaseFixture();
    const handles = ['a', 'b'].map((variant) =>
      runWorker(fixture.database, fixture.barrier, fixture.identity, variant, 'different-endpoint')
    );
    try {
      await waitForFiles(
        ['a', 'b'].map((variant) => path.join(fixture.barrier, `ready-${variant}`)),
        handles
      );
      fs.writeFileSync(path.join(fixture.barrier, 'go'), 'go');
      const results = await collectResults(handles);
      const messages = results.map((result) => workerMessage<WorkerMessage>(result));
      expect(messages.every((message) => message.ok)).toBe(true);
      expect(messages.every((message) => message.prepared?.previousRequestId === undefined)).toBe(
        true
      );

      const repository = openIdentityRepository(fixture.database);
      try {
        const attempts = repository.listAttempts();
        expect(attempts).toHaveLength(2);
        expect(new Set(attempts.map((attempt) => attempt.serverId)).size).toBe(2);
        expect(new Set(attempts.map((attempt) => attempt.socketPath)).size).toBe(2);
        expect(new Set(attempts.map((attempt) => attempt.serverStartTime)).size).toBe(2);
        expect(attempts.every((attempt) => attempt.paneId === '%same-pane')).toBe(true);
        expect(attempts.every((attempt) => attempt.waitActive)).toBe(true);
      } finally {
        repository.close();
      }
    } finally {
      await stopWorkers(handles);
    }
  }, 15_000);

  it('releases exactly one attempt without changing another waiter', async () => {
    const fixture = databaseFixture();
    const handles = ['a', 'b'].map((variant) =>
      runWorker(fixture.database, fixture.barrier, fixture.identity, variant, 'release')
    );
    try {
      await waitForFiles(
        ['a', 'b'].map((variant) => path.join(fixture.barrier, `ready-${variant}`)),
        handles
      );
      fs.writeFileSync(path.join(fixture.barrier, 'go'), 'go');
      await waitForFiles(
        ['a', 'b'].map((variant) => path.join(fixture.barrier, `prepared-${variant}`)),
        handles
      );
      fs.writeFileSync(path.join(fixture.barrier, 'release-a'), 'release');
      await waitForFiles([path.join(fixture.barrier, 'released-a')], handles);

      const repository = openIdentityRepository(fixture.database);
      try {
        const attempts = repository.listAttempts();
        expect(attempts).toHaveLength(2);
        expect(attempts.find((attempt) => attempt.requestId === 'request-a')?.waitActive).toBe(
          false
        );
        expect(attempts.find((attempt) => attempt.requestId === 'request-b')?.waitActive).toBe(
          true
        );
      } finally {
        repository.close();
      }

      fs.writeFileSync(path.join(fixture.barrier, 'release-b'), 'release');
      await waitForFiles([path.join(fixture.barrier, 'released-b')], handles);
      const results = await collectResults(handles);
      expect(
        results.map((result) => workerMessage<WorkerMessage>(result)).every((message) => message.ok)
      ).toBe(true);

      const verification = openIdentityRepository(fixture.database);
      try {
        expect(verification.listAttempts().every((attempt) => !attempt.waitActive)).toBe(true);
      } finally {
        verification.close();
      }
    } finally {
      await stopWorkers(handles);
    }
  }, 15_000);

  it('rolls back an uncommitted attempt and cadence mutation after SIGKILL', async () => {
    const fixture = databaseFixture();
    const handle = runWorker(
      fixture.database,
      fixture.barrier,
      fixture.identity,
      'kill',
      'rollback'
    );
    try {
      await waitForFiles([path.join(fixture.barrier, 'transaction-open-kill')], [handle]);
      expect(handle.child.kill('SIGKILL')).toBe(true);
      const [result] = await collectResults([handle]);
      expect(result.signal).toBe('SIGKILL');

      const repository = openIdentityRepository(fixture.database);
      try {
        const attempts = repository.listAttempts();
        expect(attempts).toHaveLength(1);
        expect(attempts[0]?.requestId).toBe('request-baseline-kill');
        expect(attempts.some((attempt) => attempt.requestId === 'request-uncommitted-kill')).toBe(
          false
        );
        expect(repository.getPreambleCount(fixture.identity)).toBe(1);
      } finally {
        repository.close();
      }
    } finally {
      await stopWorkers([handle]);
    }
  }, 15_000);
});
