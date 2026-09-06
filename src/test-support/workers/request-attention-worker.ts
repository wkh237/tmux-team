/* c8 ignore file */
import fs from 'node:fs';
import path from 'node:path';
import {
  createRequestService,
  type RequestAttemptRecord,
  type RequestEndpoint,
  type RequestRepository,
} from '../../request-service.js';
import { openIdentityRepository } from '../../storage/identity-repository.js';
import { waitForBarrier } from './barrier.js';

const [databaseFile, barrierDirectory, identityId, requestId, variant, mode] =
  process.argv.slice(2);

if (!databaseFile || !barrierDirectory || !identityId || !requestId || !variant || !mode) {
  throw new Error('Invalid attention worker arguments.');
}

const NOW_MS = 10_000;
const BARRIER_TIMEOUT_MS = 30_000;

function barrierPath(name: string): string {
  return path.join(barrierDirectory, name);
}

function signal(name: string, content = 'ready'): void {
  fs.writeFileSync(barrierPath(name), content);
}

const endpoint: RequestEndpoint = {
  serverId: 'attention-server',
  socketPath: '/tmp/attention-server',
  serverPid: 701,
  serverStartTime: 'attention-start',
  paneId: '%attention',
  panePid: 702,
};

function gatedRepository(
  base: ReturnType<typeof openIdentityRepository>,
  currentVariant: string,
  failAckAll: boolean
): { repository: RequestRepository; arm(): void } {
  let armed = false;
  const repository = {
    ...base,
    withImmediateTransaction<T>(operation: () => T): T {
      if (armed) {
        armed = false;
        signal(`tx-enter-${currentVariant}`);
        waitForBarrier(barrierPath(`release-${currentVariant}`), BARRIER_TIMEOUT_MS);
      }
      return base.withImmediateTransaction(operation);
    },
    acknowledgeAllExchanges(currentIdentityId: string, nowMs: number): number {
      const result = base.acknowledgeAllExchanges(currentIdentityId, nowMs);
      if (failAckAll) throw new Error('injected acknowledge-all failure');
      return result;
    },
  } as RequestRepository;
  return { repository, arm: () => (armed = true) };
}

function attemptFor(repository: ReturnType<typeof openIdentityRepository>): RequestAttemptRecord {
  const attempt = repository.findAttemptByRequestId(requestId);
  if (!attempt) throw new Error(`Request '${requestId}' was not found.`);
  return attempt;
}

let repository: ReturnType<typeof openIdentityRepository> | undefined;

try {
  const base = openIdentityRepository(databaseFile);
  repository = base;
  const gated = gatedRepository(base, variant, mode === 'ack-all-fail');
  const service = createRequestService({ repository: gated.repository, now: () => NOW_MS });

  signal(`ready-${variant}`);
  waitForBarrier(barrierPath('go'), BARRIER_TIMEOUT_MS);

  if (mode === 'single-ack') {
    const observed = service
      .listExchanges(identityId, { limit: 100 })
      .items.find((exchange) => exchange.requestId === requestId);
    if (!observed) throw new Error(`Request '${requestId}' was not visible before ack.`);
    const observedRevision = observed.revision;
    signal(`observed-${variant}`, String(observedRevision));
    waitForBarrier(barrierPath(`proceed-${variant}`), BARRIER_TIMEOUT_MS);
    gated.arm();
    try {
      const result = service.acknowledgeExchange(identityId, requestId, observedRevision);
      process.stdout.write(JSON.stringify({ ok: true, observedRevision, result }) + '\n');
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code: unknown }).code)
          : undefined;
      process.stdout.write(
        JSON.stringify({ ok: false, observedRevision, code, error: String(error) }) + '\n'
      );
    } finally {
      signal(`done-${variant}`);
    }
  } else if (mode === 'ack-all') {
    gated.arm();
    const result = service.acknowledgeAllExchanges(identityId);
    signal(`done-${variant}`);
    process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
  } else if (mode === 'ack-all-fail') {
    gated.arm();
    try {
      const result = service.acknowledgeAllExchanges(identityId);
      process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, error: String(error) }) + '\n');
    } finally {
      signal(`done-${variant}`);
    }
  } else if (mode === 'final') {
    const attempt = attemptFor(base);
    gated.arm();
    const result = service.submitResponse({
      requestId,
      attemptId: attempt.attemptId,
      endpoint,
      body: `final response from ${variant}`,
    });
    signal(`done-${variant}`);
    process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
  } else if (mode === 'new-request') {
    gated.arm();
    const result = service.prepare({
      requestId: `request-${variant}`,
      message: `new request from ${variant}`,
      endpoint,
      wait: false,
      expiresAtMs: NOW_MS + 60_000,
      originator: { kind: 'explicit', identityId },
    });
    signal(`done-${variant}`);
    process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
  } else {
    throw new Error(`Unknown attention worker mode '${mode}'.`);
  }
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error) }) + '\n');
  process.exitCode = 1;
} finally {
  repository?.close();
}
