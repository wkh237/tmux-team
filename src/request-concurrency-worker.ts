/* c8 ignore file */
import fs from 'node:fs';
import path from 'node:path';
import { createRequestService, type RequestEndpoint } from './request-service.js';
import { openIdentityRepository } from './storage/identity-repository.js';

const [databaseFile, barrierDirectory, identityId, variant, mode = 'prepare'] =
  process.argv.slice(2);

if (!databaseFile || !barrierDirectory || !identityId || !variant) {
  throw new Error('Invalid worker arguments.');
}

const NOW_MS = 10_000;
const BARRIER_TIMEOUT_MS = 30_000;

function barrierPath(name: string): string {
  return path.join(barrierDirectory, name);
}

function signal(name: string, content = 'ready'): void {
  fs.writeFileSync(barrierPath(name), content);
}

function waitForBarrier(name: string): void {
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(barrierPath(name))) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for barrier '${name}'.`);
    Atomics.wait(sleepBuffer, 0, 0, 10);
  }
}

function endpointFor(currentMode: string, currentVariant: string): RequestEndpoint {
  if (currentMode === 'different-endpoint') {
    const second = currentVariant.endsWith('b');
    return {
      serverId: second ? 'concurrency-server-b' : 'concurrency-server-a',
      socketPath: second ? '/tmp/concurrency-server-b' : '/tmp/concurrency-server-a',
      serverPid: second ? 124 : 123,
      serverStartTime: second ? 'concurrency-start-b' : 'concurrency-start-a',
      paneId: '%same-pane',
      panePid: second ? 457 : 456,
    };
  }
  return {
    serverId: 'concurrency-server',
    socketPath: '/tmp/concurrency-server',
    serverPid: 123,
    serverStartTime: 'concurrency-start',
    paneId: '%race',
    panePid: 456,
  };
}

function requestInput(
  currentVariant: string,
  endpoint: RequestEndpoint,
  identity: string
): Parameters<ReturnType<typeof createRequestService>['prepare']>[0] {
  return {
    requestId: `request-${currentVariant}`,
    nonce: `nonce-${currentVariant}`,
    endpoint,
    wait: true,
    expiresAtMs: NOW_MS + 1,
    preamble: { identityId: identity, every: 3 },
  };
}

let repository: ReturnType<typeof openIdentityRepository> | undefined;

try {
  repository = openIdentityRepository(databaseFile);
  const service = createRequestService({ repository, now: () => NOW_MS });
  const endpoint = endpointFor(mode, variant);

  if (mode === 'rollback') {
    // Create the baseline through the real service. The second service prepare
    // runs inside the outer transaction; the parent kills this process while
    // that transaction is open.
    service.prepare(requestInput(`baseline-${variant}`, endpoint, identityId));
    const currentRepository = repository;
    if (!currentRepository) throw new Error('The repository was not opened.');

    currentRepository.withImmediateTransaction(() => {
      // The nested service transaction is a savepoint under this outer
      // transaction. Killing the process before the outer commit must roll
      // back both the service-created attempt and its cadence reservation.
      service.prepare(requestInput(`uncommitted-${variant}`, endpoint, identityId));
      signal(`transaction-open-${variant}`);
      waitForBarrier(`kill-${variant}`);
    });
    process.stdout.write(JSON.stringify({ ok: true, rolledBack: false }) + '\n');
  } else {
    signal(`ready-${variant}`);
    waitForBarrier('go');
    const prepared = service.prepare(requestInput(variant, endpoint, identityId));

    if (mode === 'release') {
      signal(`prepared-${variant}`, prepared.attemptId);
      waitForBarrier(`release-${variant}`);
      service.releaseWait(prepared.attemptId);
      signal(`released-${variant}`);
    }

    process.stdout.write(
      JSON.stringify({ ok: true, prepared, attempt: service.getAttempt(prepared.attemptId) }) + '\n'
    );
  }
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error) }) + '\n');
  process.exitCode = 1;
} finally {
  repository?.close();
}
