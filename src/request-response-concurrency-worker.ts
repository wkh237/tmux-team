import fs from 'node:fs';
import { openIdentityRepository } from './storage/identity-repository.js';
import { createRequestService, type RequestEndpoint } from './request-service.js';

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
const nowMs = 1_700_000_000_000;
const repository = openIdentityRepository(database);
const service = createRequestService({ repository, now: () => nowMs });
if (!['submit', 'submit-gated', 'fail', 'fail-gated'].includes(mode)) {
  repository.close();
  throw new Error(`Unknown response race mode '${mode}'.`);
}

function waitForFile(file: string): void {
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

try {
  fs.writeFileSync(`${barrier}/ready-${variant}`, 'ready');
  const gate = mode === 'submit-gated' ? 'go-submit' : mode === 'fail-gated' ? 'go-fail' : 'go';
  waitForFile(`${barrier}/${gate}`);

  if (mode === 'fail' || mode === 'fail-gated') {
    service.settle(attemptId, 'definitely_failed');
    const attempt = service.getAttempt(attemptId);
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
    const attempt = service.getAttempt(attemptId);
    output({
      ok: true,
      operation: 'submit',
      response,
      attempt,
      cadence: attempt?.cadenceReserved,
    });
  }
} catch (error) {
  const typed = error as { code?: string; message?: string };
  output({
    ok: false,
    code: typed.code,
    message: typed.message ?? String(error),
    attempt: service.getAttempt(attemptId),
    cadence: service.getAttempt(attemptId)?.cadenceReserved,
  });
  process.exitCode = 0;
} finally {
  repository.close();
}
