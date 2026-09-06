import fs from 'node:fs';
import { openIdentityRepository } from '../../storage/identity-repository.js';
import { createRequestService, type RequestEndpoint } from '../../request-service.js';
import { waitForBarrier } from './barrier.js';

const [, , database, barrier, requestId, attemptId, variant, mode, body] = process.argv;
if (!database || !barrier || !requestId || !attemptId || !variant || !mode) {
  throw new Error('Usage: database barrier requestId attemptId variant mode [body]');
}
const endpoint: RequestEndpoint = {
  serverId: 'server-1',
  socketPath: '/tmp/tmt-server-1',
  serverPid: 41,
  serverStartTime: 'server-start-1',
  paneId: '%7',
  panePid: 99,
};
const baseNowMs = 1_700_000_000_000;
const scenarios: Record<
  string,
  {
    readonly operation: 'submit' | 'settle' | 'cleanup';
    readonly gate: string;
    readonly nowMs: number;
  }
> = {
  submit: { operation: 'submit', gate: 'go', nowMs: baseNowMs },
  'submit-gated': { operation: 'submit', gate: 'go-submit', nowMs: baseNowMs },
  'submit-late-gated': {
    operation: 'submit',
    gate: 'go-submit-late',
    nowMs: baseNowMs + 6 * 24 * 60 * 60 * 1000,
  },
  'submit-expiry-gated': {
    operation: 'submit',
    gate: 'go-submit-expiry',
    nowMs: baseNowMs + 7 * 24 * 60 * 60 * 1000,
  },
  fail: { operation: 'settle', gate: 'go', nowMs: baseNowMs },
  'fail-gated': { operation: 'settle', gate: 'go-fail', nowMs: baseNowMs },
  'cleanup-late-gated': {
    operation: 'cleanup',
    gate: 'go-cleanup-late',
    nowMs: baseNowMs + 6 * 24 * 60 * 60 * 1000,
  },
  'cleanup-expiry-gated': {
    operation: 'cleanup',
    gate: 'go-cleanup-expiry',
    nowMs: baseNowMs + 7 * 24 * 60 * 60 * 1000,
  },
};
const scenario = scenarios[mode];
if (!scenario) throw new Error(`Unknown response race mode '${mode}'.`);
const nowMs = scenario.nowMs;
const repository = openIdentityRepository(database);
const service = createRequestService({ repository, now: () => nowMs });

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

try {
  fs.writeFileSync(`${barrier}/ready-${variant}`, 'ready');
  waitForBarrier(`${barrier}/${scenario.gate}`, 15_000);

  if (scenario.operation === 'cleanup') {
    service.cleanup();
    const attempt = repository.findAttempt(attemptId);
    output({
      ok: true,
      operation: 'cleanup',
      attempt: attempt ?? null,
      rawResponse: repository.findResponse(requestId) ?? null,
      cadence: attempt?.cadenceReserved,
    });
  } else if (scenario.operation === 'settle') {
    service.settle(attemptId, 'definitely_failed');
    const attempt = repository.findAttempt(attemptId);
    output({
      ok: true,
      operation: 'settle',
      attempt,
      cadence: attempt?.cadenceReserved,
    });
  } else {
    const response = service.submitResponse({
      requestId,
      attemptId,
      endpoint,
      body: body ?? '',
    });
    const attempt = repository.findAttempt(attemptId);
    output({
      ok: true,
      operation: 'submit',
      response,
      attempt,
      cadence: attempt?.cadenceReserved,
      rawResponse: repository.findResponse(requestId) ?? null,
    });
  }
} catch (error) {
  const typed = error as { code?: string; message?: string };
  const attempt = repository.findAttempt(attemptId);
  output({
    ok: false,
    code: typed.code,
    message: typed.message ?? String(error),
    attempt: attempt ?? null,
    cadence: attempt?.cadenceReserved,
    rawResponse: repository.findResponse(requestId) ?? null,
  });
  process.exitCode = 0;
} finally {
  repository.close();
}
