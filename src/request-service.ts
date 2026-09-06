import crypto from 'node:crypto';
import {
  ResponseError,
  validateResponseBody,
  type ValidatedResponseBody,
} from './domain/response.js';
import {
  RequestInputError,
  validateRequestMessage,
  type ValidatedRequestMessage,
} from './domain/request-content.js';
import {
  addExchangeRetentionMs,
  assertExchangeRetentionDays,
  DEFAULT_EXCHANGE_RETENTION_DAYS,
  EXCHANGE_METADATA_SETTLEMENT_FLOOR_MS,
  EXCHANGE_RESPONSE_ACCEPTANCE_WINDOW_MS,
} from './domain/exchange-retention.js';
import {
  DEFAULT_EXCHANGE_LIST_LIMIT,
  ExchangeAttentionError,
  MAX_EXCHANGE_LIST_LIMIT,
  projectExchangeFinalDetail,
  projectExchangeSummary,
  type ExchangeAttentionRepository,
  type ExchangeDetail,
  type ExchangeSummary,
} from './request-attention.js';
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

export type RequestOriginator =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'explicit' | 'verified'; readonly identityId: string };

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
  readonly originator: RequestOriginator;
  readonly recipientIdentityId?: string;
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
  /** Immutable completion tombstone retained with attempt metadata after body pruning. */
  readonly responseSubmittedAtMs?: number;
  readonly expiresAtMs: number;
  /** Frozen policy used to retain this attempt and any response it accepts. */
  readonly retentionDays: number;
  /** Metadata horizon, extended only by a first explicit settlement or accepted final. */
  readonly retentionExpiresAtMs: number;
}

export interface RequestResponseSubmission {
  readonly requestId: string;
  readonly attemptId: string;
  readonly endpoint: RequestEndpoint;
  readonly body: string;
}

export interface RequestResponseRecord {
  readonly requestId: string;
  readonly attemptId: string;
  readonly endpoint: RequestEndpoint;
  readonly body: string;
  readonly bodyBytes: number;
  readonly submittedAtMs: number;
  /** Independent logical/physical body horizon anchored at submission. */
  readonly responseExpiresAtMs: number;
}

export interface RequestPreparationInput {
  readonly requestId: string;
  readonly message: string;
  readonly nonce?: string;
  readonly endpoint: RequestEndpoint;
  readonly wait: boolean;
  readonly expiresAtMs: number;
  readonly originator?: RequestOriginator;
  readonly recipientIdentityId?: string;
  readonly preamble?: {
    readonly identityId: string;
    readonly every: number;
  };
}

export type RequestPrompt =
  | {
      readonly status: 'retained';
      readonly message: string;
      readonly messageBytes: number;
      readonly expiresAtMs: number;
    }
  | { readonly status: 'expired'; readonly expiresAtMs: number }
  | { readonly status: 'unavailable' };

export interface RequestContext {
  readonly attempt: RequestAttemptRecord;
  readonly prompt: RequestPrompt;
}

export interface RequestPromptStorage {
  readonly message: string;
  readonly messageBytes: number;
  readonly expiresAtMs: number;
}

export interface RawRequestContext {
  readonly attempt: RequestAttemptRecord;
  readonly promptMessage?: string;
  readonly promptMessageBytes?: number;
  readonly promptExpiresAtMs?: number;
}

export interface RequestPreparation {
  readonly attemptId: string;
  readonly requestId: string;
  readonly injectPreamble: boolean;
  readonly previousRequestId?: string;
}

export interface RequestRepository extends ExchangeAttentionRepository {
  withImmediateTransaction<T>(operation: () => T): T;
  createAttempt(
    attempt: RequestAttemptRecord,
    prompt?: RequestPromptStorage,
    attentionRevision?: number
  ): void;
  findAttempt(attemptId: string): RequestAttemptRecord | undefined;
  findAttemptByRequestId(requestId: string): RequestAttemptRecord | undefined;
  findRequestContext(requestId: string): RawRequestContext | undefined;
  findResponse(requestId: string): RequestResponseRecord | undefined;
  /** Must run inside the caller's immediate transaction with marker insertion. */
  createResponse(response: RequestResponseRecord): void;
  findActiveRequest(endpoint: RequestEndpoint): string | undefined;
  /** A supplied horizon extends metadata atomically with an explicit settlement. */
  updateAttemptState(
    attemptId: string,
    expectedStatus: RequestAttemptStatus,
    status: RequestAttemptStatus,
    cadenceReserved: boolean,
    nowMs: number,
    retentionExpiresAtMs?: number
  ): boolean;
  releaseWait(attemptId: string, nowMs: number): boolean;
  getPreambleCount(identityId: string): number;
  setPreambleCount(identityId: string, count: number, nowMs: number): void;
  deleteRetained(nowMs: number, limit: number): void;
  deleteRetainedResponses(nowMs: number, limit: number): void;
  clearExpiredPrompts(nowMs: number, limit: number): void;
  listExpiredAttempts(nowMs: number, limit: number): RequestAttemptRecord[];
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
  submitResponse(input: RequestResponseSubmission): RequestResponseRecord;
  getResponse(requestId: string): RequestResponseRecord | undefined;
  getRequestContext(requestId: string): RequestContext | undefined;
  listExchanges(
    identityId: string,
    options?: { readonly limit?: number; readonly after?: number }
  ): { items: ExchangeSummary[]; nextAfter: number | null };
  showExchange(identityId: string, requestId: string): ExchangeDetail;
  acknowledgeExchange(
    identityId: string,
    requestId: string,
    revision: number
  ): { requestId: string; revision: number; acknowledged: true; changed: boolean };
  acknowledgeAllExchanges(identityId: string): { acknowledgedThrough: number };
}

export const REQUEST_RETENTION_MS = EXCHANGE_METADATA_SETTLEMENT_FLOOR_MS;
export const REQUEST_MIN_EXPIRY_MS = 60 * 60 * 1000;
export const RESPONSE_ACCEPTANCE_WINDOW_MS = EXCHANGE_RESPONSE_ACCEPTANCE_WINDOW_MS;
export const CLEANUP_BATCH_SIZE = 100;

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function assertAttentionIdentity(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ExchangeAttentionError('X_INPUT_INVALID', 'Identity ID must be a non-empty string.');
  }
}

function assertAttentionRequest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ExchangeAttentionError('X_INPUT_INVALID', 'Request ID must be a non-empty string.');
  }
}

function assertAttentionRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ExchangeAttentionError(
      'X_INPUT_INVALID',
      'Attention revision must be a positive safe integer.'
    );
  }
}

function attentionListOptions(options?: { readonly limit?: number; readonly after?: number }): {
  limit: number;
  after: number;
} {
  if (
    options !== undefined &&
    (typeof options !== 'object' || options === null || Array.isArray(options))
  ) {
    throw new ExchangeAttentionError('X_INPUT_INVALID', 'Exchange list options are invalid.');
  }
  const limit = options === undefined ? DEFAULT_EXCHANGE_LIST_LIMIT : options.limit;
  const after = options === undefined ? 0 : options.after;
  const effectiveLimit = limit === undefined ? DEFAULT_EXCHANGE_LIST_LIMIT : limit;
  const effectiveAfter = after === undefined ? 0 : after;
  if (
    !Number.isSafeInteger(effectiveLimit) ||
    effectiveLimit <= 0 ||
    effectiveLimit > MAX_EXCHANGE_LIST_LIMIT
  ) {
    throw new ExchangeAttentionError(
      'X_INPUT_INVALID',
      `Exchange list limit must be an integer from 1 through ${MAX_EXCHANGE_LIST_LIMIT}.`
    );
  }
  if (!Number.isSafeInteger(effectiveAfter) || effectiveAfter < 0) {
    throw new ExchangeAttentionError(
      'X_INPUT_INVALID',
      'Exchange list cursor must be a non-negative safe integer.'
    );
  }
  return { limit: effectiveLimit, after: effectiveAfter };
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

function sameEndpoint(left: RequestEndpoint, right: RequestEndpoint): boolean {
  return (
    left.serverId === right.serverId &&
    left.socketPath === right.socketPath &&
    left.serverPid === right.serverPid &&
    left.serverStartTime === right.serverStartTime &&
    left.paneId === right.paneId &&
    left.panePid === right.panePid
  );
}

function validateResponseInput(input: RequestResponseSubmission): ValidatedResponseBody {
  if (!input || typeof input !== 'object') {
    throw new ResponseError('RESPONSE_INPUT_INVALID', 'Response submission must be an object.');
  }
  try {
    assertString(input.requestId, 'requestId');
    assertString(input.attemptId, 'attemptId');
    if (!input.endpoint || typeof input.endpoint !== 'object') {
      throw new Error('endpoint must be an object.');
    }
    validateEndpoint(input.endpoint);
  } catch (error) {
    throw new ResponseError(
      'RESPONSE_INPUT_INVALID',
      error instanceof Error ? error.message : 'Response submission is invalid.',
      { cause: error }
    );
  }
  return validateResponseBody(input.body);
}

function isResponseExpired(response: RequestResponseRecord, currentMs: number): boolean {
  return currentMs >= response.responseExpiresAtMs;
}

function isPastResponseDeadline(attempt: RequestAttemptRecord, currentMs: number): boolean {
  // max(expiresAtMs, preparedAtMs + RESPONSE_ACCEPTANCE_WINDOW_MS), expressed with
  // subtraction so a clock near MAX_SAFE_INTEGER never overflows.
  return (
    currentMs >= attempt.expiresAtMs &&
    currentMs >= attempt.preparedAtMs &&
    currentMs - attempt.preparedAtMs >= RESPONSE_ACCEPTANCE_WINDOW_MS
  );
}

function addMilliseconds(value: number, delta: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || !Number.isSafeInteger(delta) || delta < 0) {
    throw new Error(`${label} is outside the supported range.`);
  }
  if (value > Number.MAX_SAFE_INTEGER - delta) {
    throw new Error(`${label} is outside the supported range.`);
  }
  return value + delta;
}

function validateOriginator(originator: RequestOriginator | undefined): void {
  if (originator === undefined) return;
  if (!originator || typeof originator !== 'object') {
    throw new RequestInputError('REQUEST_INPUT_INVALID', 'Request originator is invalid.');
  }
  if (originator.kind === 'unknown') {
    if ('identityId' in originator && originator.identityId !== undefined) {
      throw new RequestInputError(
        'REQUEST_INPUT_INVALID',
        'Unknown request originators cannot include an identity ID.'
      );
    }
    return;
  }
  if (originator.kind !== 'explicit' && originator.kind !== 'verified') {
    throw new RequestInputError('REQUEST_INPUT_INVALID', 'Request originator is invalid.');
  }
  if (typeof originator.identityId !== 'string' || originator.identityId.length === 0) {
    throw new RequestInputError(
      'REQUEST_INPUT_INVALID',
      'Selected request originators require an identity ID.'
    );
  }
}

function validatePreparation(input: RequestPreparationInput): ValidatedRequestMessage {
  assertString(input.requestId, 'requestId');
  const message = validateRequestMessage(input.message);
  if (input.nonce !== undefined) assertString(input.nonce, 'nonce');
  validateEndpoint(input.endpoint);
  if (typeof input.wait !== 'boolean') throw new Error('wait must be boolean.');
  assertPositiveInteger(input.expiresAtMs, 'expiresAtMs');
  validateOriginator(input.originator);
  if (input.recipientIdentityId !== undefined) {
    assertString(input.recipientIdentityId, 'recipientIdentityId');
  }
  if (input.preamble) {
    assertString(input.preamble.identityId, 'preamble.identityId');
    assertPositiveInteger(input.preamble.every, 'preamble.every');
  }
  return message;
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
  readonly getRetentionDays?: () => number;
}): RequestService {
  const { repository } = options;
  if (!repository) throw new Error('Request repository is required.');
  const now = options.now ?? Date.now;
  const getRetentionDays = options.getRetentionDays ?? (() => DEFAULT_EXCHANGE_RETENTION_DAYS);

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
    currentMs: number,
    retentionExpiresAtMs?: number
  ): boolean => {
    const transitioned = repository.updateAttemptState(
      attempt.attemptId,
      attempt.status,
      'definitely_failed',
      false,
      currentMs,
      retentionExpiresAtMs
    );
    if (transitioned) refundAttempt(attempt, currentMs);
    return transitioned;
  };

  const cleanupWithinTransaction = (currentMs: number): void => {
    for (const attempt of repository.listExpiredAttempts(currentMs, CLEANUP_BATCH_SIZE)) {
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
    repository.clearExpiredPrompts(currentMs, CLEANUP_BATCH_SIZE);
    repository.deleteRetainedResponses(currentMs, CLEANUP_BATCH_SIZE);
    repository.deleteRetained(currentMs, CLEANUP_BATCH_SIZE);
  };

  const readWithCleanup = <T>(read: (currentMs: number) => T): T =>
    repository.withImmediateTransaction(() => {
      const currentMs = readNow();
      cleanupWithinTransaction(currentMs);
      return read(currentMs);
    });

  const projectRequestContext = (
    requestId: string,
    currentMs: number
  ): RequestContext | undefined => {
    const raw = repository.findRequestContext(requestId);
    if (!raw || currentMs >= raw.attempt.retentionExpiresAtMs) return undefined;
    const expiresAtMs = raw.promptExpiresAtMs;
    if (expiresAtMs === undefined) {
      return { attempt: raw.attempt, prompt: { status: 'unavailable' } };
    }
    // The expiry marker survives physical scrubbing. A subsequent clock
    // rollback cannot turn a deleted prompt into historical unknown data.
    if (
      currentMs >= expiresAtMs ||
      raw.promptMessage === undefined ||
      raw.promptMessageBytes === undefined
    ) {
      return { attempt: raw.attempt, prompt: { status: 'expired', expiresAtMs } };
    }
    return {
      attempt: raw.attempt,
      prompt: {
        status: 'retained',
        message: raw.promptMessage,
        messageBytes: raw.promptMessageBytes,
        expiresAtMs,
      },
    };
  };

  return {
    prepare(input) {
      const validatedMessage = validatePreparation(input);
      const retentionDays = getRetentionDays();
      assertExchangeRetentionDays(retentionDays);
      const attemptId = makeAttemptId();

      return repository.withImmediateTransaction(() => {
        const currentMs = readNow();
        const minimumExpiry = addMilliseconds(currentMs, REQUEST_MIN_EXPIRY_MS, 'minimum expiry');
        const expiresAtMs = Math.max(input.expiresAtMs, minimumExpiry);
        const messageExpiresAtMs = addExchangeRetentionMs(currentMs, retentionDays);
        const retentionExpiresAtMs = Math.max(
          messageExpiresAtMs,
          addMilliseconds(currentMs, RESPONSE_ACCEPTANCE_WINDOW_MS, 'response acceptance deadline'),
          addMilliseconds(expiresAtMs, REQUEST_RETENTION_MS, 'settlement retention floor')
        );
        cleanupWithinTransaction(currentMs);
        if (repository.findResponse(input.requestId)) {
          throw new Error(`Request '${input.requestId}' already has a retained response.`);
        }
        const attentionRevision =
          input.originator && input.originator.kind !== 'unknown'
            ? repository.reserveAttentionRevision(input.originator.identityId)
            : undefined;
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

        repository.createAttempt(
          {
            attemptId,
            requestId: input.requestId,
            originator: input.originator ?? { kind: 'unknown' },
            ...(input.recipientIdentityId && { recipientIdentityId: input.recipientIdentityId }),
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
            retentionDays,
            retentionExpiresAtMs,
          },
          {
            message: validatedMessage.message,
            messageBytes: validatedMessage.messageBytes,
            expiresAtMs: messageExpiresAtMs,
          },
          attentionRevision
        );

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
        if (attempt.retentionExpiresAtMs <= currentMs) {
          throw new Error(`Request attempt '${attemptId}' metadata has expired.`);
        }
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
          currentMs >= attempt.retentionExpiresAtMs &&
          (attempt.status === 'prepared' || attempt.status === 'sending')
        ) {
          throw new Error(`Request attempt '${attemptId}' metadata has expired.`);
        }
        // An accepted reply prevents proving that the recipient was not reached;
        // a sending attempt therefore settles conservatively as uncertain.
        const cannotProveUnsent =
          (attempt.status === 'sending' && attempt.expiresAtMs <= currentMs) ||
          (attempt.responseSubmittedAtMs !== undefined &&
            (attempt.status === 'sending' || attempt.status === 'uncertain'));
        const effectiveOutcome =
          outcome === 'definitely_failed' && cannotProveUnsent ? 'uncertain' : outcome;
        if (
          attempt.status === 'sent' ||
          attempt.status === 'uncertain' ||
          attempt.status === 'definitely_failed'
        ) {
          if (attempt.status !== effectiveOutcome) {
            throw new Error(`Request attempt '${attemptId}' is already ${attempt.status}.`);
          }
          return;
        }
        if (effectiveOutcome !== 'definitely_failed' && attempt.status !== 'sending') {
          throw new Error(`Request attempt '${attemptId}' is still ${attempt.status}.`);
        }
        if (
          effectiveOutcome === 'definitely_failed' &&
          !['prepared', 'sending'].includes(attempt.status)
        ) {
          throw new Error(`Request attempt '${attemptId}' is still ${attempt.status}.`);
        }
        // Only a new, explicit settlement earns this floor. Cleanup and repeat
        // settlement calls must not renew the frozen metadata deadline.
        const retentionExpiresAtMs = Math.max(
          attempt.retentionExpiresAtMs,
          addMilliseconds(currentMs, REQUEST_RETENTION_MS, 'settlement retention floor')
        );
        if (effectiveOutcome === 'definitely_failed') {
          if (!transitionDefinitelyFailed(attempt, currentMs, retentionExpiresAtMs)) {
            throw new Error(`Request attempt '${attemptId}' could not settle.`);
          }
        } else {
          const transitioned = repository.updateAttemptState(
            attemptId,
            attempt.status,
            effectiveOutcome,
            attempt.cadenceReserved,
            currentMs,
            retentionExpiresAtMs
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
      return readWithCleanup((currentMs) => {
        const attempt = repository.findAttempt(attemptId);
        return attempt && currentMs < attempt.retentionExpiresAtMs ? attempt : undefined;
      });
    },

    listAttempts() {
      return readWithCleanup((currentMs) =>
        repository.listAttempts().filter((attempt) => currentMs < attempt.retentionExpiresAtMs)
      );
    },

    submitResponse(input) {
      const validated = validateResponseInput(input);
      return repository.withImmediateTransaction(() => {
        const currentMs = readNow();
        const existing = repository.findResponse(input.requestId);
        if (existing) {
          if (existing.attemptId !== input.attemptId) {
            throw new ResponseError(
              'RESPONSE_ATTEMPT_MISMATCH',
              `Attempt '${input.attemptId}' does not belong to request '${input.requestId}'.`
            );
          }
          if (!sameEndpoint(existing.endpoint, input.endpoint)) {
            throw new ResponseError(
              'RESPONSE_RECIPIENT_MISMATCH',
              `Response submission for request '${input.requestId}' does not match its original recipient.`
            );
          }
          if (isResponseExpired(existing, currentMs)) {
            throw new ResponseError(
              'RESPONSE_EXPIRED',
              `Final response for request '${input.requestId}' is no longer retained.`
            );
          }
          if (existing.body !== input.body) {
            throw new ResponseError(
              'RESPONSE_CONFLICT',
              `Request '${input.requestId}' already has a different final response.`
            );
          }
          return existing;
        }

        const attempt = repository.findAttemptByRequestId(input.requestId);
        if (!attempt) {
          throw new ResponseError(
            'RESPONSE_REQUEST_NOT_FOUND',
            `Request '${input.requestId}' was not found.`
          );
        }
        if (attempt.attemptId !== input.attemptId) {
          throw new ResponseError(
            'RESPONSE_ATTEMPT_MISMATCH',
            `Attempt '${input.attemptId}' does not belong to request '${input.requestId}'.`
          );
        }
        if (!sameEndpoint(attempt, input.endpoint)) {
          throw new ResponseError(
            'RESPONSE_RECIPIENT_MISMATCH',
            `Response submission for request '${input.requestId}' does not match its original recipient.`
          );
        }
        if (
          attempt.responseSubmittedAtMs !== undefined ||
          isPastResponseDeadline(attempt, currentMs)
        ) {
          throw new ResponseError(
            'RESPONSE_EXPIRED',
            `Final response for request '${input.requestId}' can no longer be accepted.`
          );
        }
        if (
          attempt.status !== 'sending' &&
          attempt.status !== 'sent' &&
          attempt.status !== 'uncertain'
        ) {
          throw new ResponseError(
            'RESPONSE_STATE_INVALID',
            `Final response cannot be accepted while request attempt '${input.attemptId}' is ${attempt.status}.`
          );
        }

        const response: RequestResponseRecord = {
          requestId: input.requestId,
          attemptId: input.attemptId,
          endpoint: { ...input.endpoint },
          body: validated.body,
          bodyBytes: validated.bodyBytes,
          submittedAtMs: currentMs,
          responseExpiresAtMs: addExchangeRetentionMs(currentMs, attempt.retentionDays),
        };
        repository.createResponse(response);
        repository.advanceAttentionRevision(input.requestId);
        return response;
      });
    },

    getResponse(requestId) {
      try {
        assertString(requestId, 'requestId');
      } catch (error) {
        throw new ResponseError(
          'RESPONSE_INPUT_INVALID',
          error instanceof Error ? error.message : 'requestId must be a non-empty string.',
          { cause: error }
        );
      }
      return readWithCleanup((currentMs) => {
        const response = repository.findResponse(requestId);
        return response && !isResponseExpired(response, currentMs) ? response : undefined;
      });
    },

    getRequestContext(requestId) {
      assertString(requestId, 'requestId');
      return readWithCleanup((currentMs) => projectRequestContext(requestId, currentMs));
    },

    listExchanges(identityId, options) {
      assertAttentionIdentity(identityId);
      const { limit, after } = attentionListOptions(options);
      return readWithCleanup((currentMs) => {
        const records = repository.listExchangeAttention(identityId, after, limit + 1, currentMs);
        const items = records
          .slice(0, limit)
          .map((record) => projectExchangeSummary(record, currentMs));
        return {
          items,
          nextAfter: records.length > limit ? (items.at(-1)?.revision ?? null) : null,
        };
      });
    },

    showExchange(identityId, requestId) {
      assertAttentionIdentity(identityId);
      assertAttentionRequest(requestId);
      return readWithCleanup((currentMs): ExchangeDetail => {
        const record = repository.findExchangeAttention(identityId, requestId);
        if (!record) {
          throw new ExchangeAttentionError(
            'X_NOT_FOUND',
            `Exchange '${requestId}' was not found for identity '${identityId}'.`
          );
        }
        const context = projectRequestContext(requestId, currentMs);
        if (!context) {
          throw new ExchangeAttentionError(
            'X_NOT_FOUND',
            `Exchange '${requestId}' is no longer retained.`
          );
        }
        const response = repository.findResponse(requestId);
        return projectExchangeFinalDetail(
          projectExchangeSummary(record, currentMs),
          context,
          response,
          currentMs
        );
      });
    },

    acknowledgeExchange(identityId, requestId, revision) {
      assertAttentionIdentity(identityId);
      assertAttentionRequest(requestId);
      assertAttentionRevision(revision);
      return readWithCleanup((currentMs) => {
        const result = repository.acknowledgeExchange(identityId, requestId, revision, currentMs);
        return {
          requestId,
          revision,
          acknowledged: true as const,
          changed: result.changed,
        };
      });
    },

    acknowledgeAllExchanges(identityId) {
      assertAttentionIdentity(identityId);
      return readWithCleanup((currentMs) => ({
        acknowledgedThrough: repository.acknowledgeAllExchanges(identityId, currentMs),
      }));
    },
  };
}
