import crypto from 'node:crypto';
import type { TmuxEndpointSnapshot } from './types.js';

export type RequestAttemptStatus =
  | 'prepared'
  | 'sending'
  | 'sent'
  | 'uncertain'
  | 'definitely_failed';

export type RequestSettlement = Extract<
  RequestAttemptStatus,
  'sent' | 'uncertain' | 'definitely_failed'
>;

/** The endpoint instance a request was prepared for. Pane IDs are not enough: they can be reused. */
export interface RequestEndpoint {
  readonly serverId: string;
  readonly socketPath: string;
  readonly serverPid: number;
  readonly serverStartTime: string;
  readonly paneId: string;
  readonly panePid: number;
}

export interface RequestAttemptRecord extends RequestEndpoint {
  readonly attemptId: string;
  readonly requestId: string;
  readonly nonce?: string;
  readonly identityId?: string;
  readonly waitActive: boolean;
  readonly status: RequestAttemptStatus;
  readonly preambleEvery?: number;
  readonly injectPreamble: boolean;
  readonly cadenceReserved: boolean;
  readonly preparedAtMs: number;
  readonly sendingAtMs?: number;
  readonly settledAtMs?: number;
  readonly waitReleasedAtMs?: number;
  readonly expiresAtMs: number;
}

export interface RequestPreparationInput {
  readonly requestId: string;
  readonly nonce?: string;
  readonly endpoint: RequestEndpoint;
  readonly wait: boolean;
  readonly expiresAtMs: number;
  readonly preamble?: {
    readonly identityId: string;
    readonly every: number;
  };
}

export interface RequestPreparation {
  readonly attemptId: string;
  readonly requestId: string;
  readonly injectPreamble: boolean;
  readonly previousRequestId?: string;
}

export interface RequestRepository {
  withImmediateTransaction<T>(operation: () => T): T;
  createAttempt(attempt: RequestAttemptRecord): void;
  findAttempt(attemptId: string): RequestAttemptRecord | undefined;
  findActiveRequest(endpoint: RequestEndpoint): string | undefined;
  updateAttemptState(
    attemptId: string,
    expectedStatus: RequestAttemptStatus,
    status: RequestAttemptStatus,
    cadenceReserved: boolean,
    nowMs: number
  ): boolean;
  releaseWait(attemptId: string, nowMs: number): boolean;
  getPreambleCount(identityId: string): number;
  setPreambleCount(identityId: string, count: number, nowMs: number): void;
  deleteRetained(nowMs: number, retentionMs: number): void;
  listExpiredAttempts(nowMs: number): RequestAttemptRecord[];
  listAttempts(): RequestAttemptRecord[];
}

export interface RequestService {
  prepare(input: RequestPreparationInput): RequestPreparation;
  beginSend(attemptId: string): void;
  settle(attemptId: string, outcome: RequestSettlement): void;
  releaseWait(attemptId: string): void;
  cleanup(): void;
  getAttempt(attemptId: string): RequestAttemptRecord | undefined;
  listAttempts(): RequestAttemptRecord[];
}

export const REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000;
export const REQUEST_MIN_EXPIRY_MS = 60 * 60 * 1000;

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function assertPositiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
}

function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}

function assertSettlement(value: unknown): asserts value is RequestSettlement {
  if (value !== 'sent' && value !== 'uncertain' && value !== 'definitely_failed') {
    throw new Error(`Invalid request settlement '${String(value)}'.`);
  }
}

function validateEndpoint(endpoint: RequestEndpoint): void {
  assertString(endpoint.serverId, 'endpoint.serverId');
  assertString(endpoint.socketPath, 'endpoint.socketPath');
  assertString(endpoint.serverStartTime, 'endpoint.serverStartTime');
  assertString(endpoint.paneId, 'endpoint.paneId');
  assertPositiveInteger(endpoint.serverPid, 'endpoint.serverPid');
  assertPositiveInteger(endpoint.panePid, 'endpoint.panePid');
}

function validatePreparation(input: RequestPreparationInput): void {
  assertString(input.requestId, 'requestId');
  if (input.nonce !== undefined) assertString(input.nonce, 'nonce');
  validateEndpoint(input.endpoint);
  if (typeof input.wait !== 'boolean') throw new Error('wait must be boolean.');
  assertPositiveInteger(input.expiresAtMs, 'expiresAtMs');
  if (input.preamble) {
    assertString(input.preamble.identityId, 'preamble.identityId');
    assertPositiveInteger(input.preamble.every, 'preamble.every');
  }
}

function makeAttemptId(): string {
  return crypto.randomUUID();
}

/** Convert one authoritative tmux snapshot into the endpoint fence stored with an attempt. */
export function endpointFromSnapshot(
  snapshot: TmuxEndpointSnapshot,
  paneId: string
): RequestEndpoint {
  assertString(paneId, 'paneId');
  const pane = snapshot.panes.find((item) => item.id === paneId);
  if (!pane || pane.panePid === undefined) {
    throw new Error(`Pane '${paneId}' is absent or has incomplete endpoint evidence.`);
  }
  assertPositiveInteger(pane.panePid, 'pane.panePid');
  const endpoint = {
    serverId: snapshot.server.serverId,
    socketPath: snapshot.server.socketPath,
    serverPid: snapshot.server.serverPid,
    serverStartTime: snapshot.server.serverStartTime,
    paneId,
    panePid: pane.panePid,
  };
  validateEndpoint(endpoint);
  return endpoint;
}

export function createRequestService(options: {
  readonly repository: RequestRepository;
  readonly now?: () => number;
}): RequestService {
  const { repository } = options;
  if (!repository) throw new Error('Request repository is required.');
  const now = options.now ?? Date.now;

  const readNow = (): number => {
    const value = now();
    assertPositiveInteger(value, 'now');
    return value;
  };

  const refundAttempt = (attempt: RequestAttemptRecord, currentMs: number): void => {
    if (!attempt.cadenceReserved || !attempt.identityId) return;
    const count = repository.getPreambleCount(attempt.identityId);
    assertNonNegativeInteger(count, 'preamble cadence count');
    repository.setPreambleCount(attempt.identityId, Math.max(0, count - 1), currentMs);
  };

  const transitionDefinitelyFailed = (
    attempt: RequestAttemptRecord,
    currentMs: number
  ): boolean => {
    const transitioned = repository.updateAttemptState(
      attempt.attemptId,
      attempt.status,
      'definitely_failed',
      false,
      currentMs
    );
    if (transitioned) refundAttempt(attempt, currentMs);
    return transitioned;
  };

  const cleanupWithinTransaction = (currentMs: number): void => {
    for (const attempt of repository.listExpiredAttempts(currentMs)) {
      if (attempt.waitActive) repository.releaseWait(attempt.attemptId, currentMs);
      if (attempt.status === 'prepared') {
        transitionDefinitelyFailed(attempt, currentMs);
      } else if (attempt.status === 'sending') {
        repository.updateAttemptState(
          attempt.attemptId,
          'sending',
          'uncertain',
          attempt.cadenceReserved,
          currentMs
        );
      }
    }
    repository.deleteRetained(currentMs, REQUEST_RETENTION_MS);
  };

  return {
    prepare(input) {
      validatePreparation(input);
      const attemptId = makeAttemptId();

      return repository.withImmediateTransaction(() => {
        const currentMs = readNow();
        const minimumExpiry = currentMs + REQUEST_MIN_EXPIRY_MS;
        assertPositiveInteger(minimumExpiry, 'minimum expiry');
        const expiresAtMs = Math.max(input.expiresAtMs, minimumExpiry);
        cleanupWithinTransaction(currentMs);
        const previousRequestId = repository.findActiveRequest(input.endpoint);
        let injectPreamble = false;
        let cadenceReserved = false;
        if (input.preamble) {
          const count = repository.getPreambleCount(input.preamble.identityId);
          assertNonNegativeInteger(count, 'preamble cadence count');
          if (count >= Number.MAX_SAFE_INTEGER) {
            throw new Error('Preamble cadence counter is exhausted.');
          }
          injectPreamble = count % input.preamble.every === 0;
          repository.setPreambleCount(input.preamble.identityId, count + 1, currentMs);
          cadenceReserved = true;
        }

        repository.createAttempt({
          attemptId,
          requestId: input.requestId,
          ...(input.nonce !== undefined && { nonce: input.nonce }),
          ...input.endpoint,
          ...(input.preamble && { identityId: input.preamble.identityId }),
          waitActive: input.wait,
          status: 'prepared',
          ...(input.preamble && { preambleEvery: input.preamble.every }),
          injectPreamble,
          cadenceReserved,
          preparedAtMs: currentMs,
          expiresAtMs,
        });

        return {
          attemptId,
          requestId: input.requestId,
          injectPreamble,
          ...(previousRequestId && { previousRequestId }),
        };
      });
    },

    beginSend(attemptId) {
      assertString(attemptId, 'attemptId');
      let expired = false;
      const transitioned = repository.withImmediateTransaction(() => {
        const currentMs = readNow();
        const attempt = repository.findAttempt(attemptId);
        if (!attempt) throw new Error(`Request attempt '${attemptId}' was not found.`);
        if (attempt.status !== 'prepared') {
          throw new Error(`Request attempt '${attemptId}' is already ${attempt.status}.`);
        }
        if (attempt.expiresAtMs <= currentMs) {
          if (attempt.waitActive) repository.releaseWait(attemptId, currentMs);
          transitionDefinitelyFailed(attempt, currentMs);
          expired = true;
          return false;
        }
        return repository.updateAttemptState(
          attemptId,
          'prepared',
          'sending',
          attempt.cadenceReserved,
          currentMs
        );
      });
      if (expired) throw new Error(`Request attempt '${attemptId}' has expired.`);
      if (!transitioned) throw new Error(`Request attempt '${attemptId}' could not begin sending.`);
    },

    settle(attemptId, outcome) {
      assertString(attemptId, 'attemptId');
      assertSettlement(outcome);
      repository.withImmediateTransaction(() => {
        const currentMs = readNow();
        const attempt = repository.findAttempt(attemptId);
        if (!attempt) throw new Error(`Request attempt '${attemptId}' was not found.`);
        if (
          attempt.status === 'sent' ||
          attempt.status === 'uncertain' ||
          attempt.status === 'definitely_failed'
        ) {
          if (attempt.status !== outcome) {
            throw new Error(`Request attempt '${attemptId}' is already ${attempt.status}.`);
          }
          return;
        }
        if (outcome !== 'definitely_failed' && attempt.status !== 'sending') {
          throw new Error(`Request attempt '${attemptId}' is still ${attempt.status}.`);
        }
        if (outcome === 'definitely_failed' && !['prepared', 'sending'].includes(attempt.status)) {
          throw new Error(`Request attempt '${attemptId}' is still ${attempt.status}.`);
        }
        // Once a sending attempt's expiry has elapsed, the effect may have happened.
        // Preserve the conservative uncertain outcome rather than refunding it.
        const effectiveOutcome =
          outcome === 'definitely_failed' &&
          attempt.status === 'sending' &&
          attempt.expiresAtMs <= currentMs
            ? 'uncertain'
            : outcome;
        if (effectiveOutcome === 'definitely_failed') {
          if (!transitionDefinitelyFailed(attempt, currentMs)) {
            throw new Error(`Request attempt '${attemptId}' could not settle.`);
          }
        } else {
          const transitioned = repository.updateAttemptState(
            attemptId,
            attempt.status,
            effectiveOutcome,
            attempt.cadenceReserved,
            currentMs
          );
          if (!transitioned) {
            throw new Error(`Request attempt '${attemptId}' could not settle.`);
          }
        }
      });
    },

    releaseWait(attemptId) {
      assertString(attemptId, 'attemptId');
      repository.withImmediateTransaction(() => {
        repository.releaseWait(attemptId, readNow());
      });
    },

    cleanup() {
      repository.withImmediateTransaction(() => {
        const currentMs = readNow();
        cleanupWithinTransaction(currentMs);
      });
    },

    getAttempt(attemptId) {
      assertString(attemptId, 'attemptId');
      return repository.findAttempt(attemptId);
    },

    listAttempts() {
      return repository.listAttempts();
    },
  };
}
