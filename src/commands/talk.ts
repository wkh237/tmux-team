// ─────────────────────────────────────────────────────────────
// talk command - send a message to one resolved pane
// ─────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Context } from '../types.js';
import type { TalkRequest } from '../cli/requests.js';
import { ExitCodes } from '../exits.js';
import { encodeReplyReceipt, type ReplyReceipt } from '../reply-receipt.js';
import {
  endpointFromSnapshot,
  type RequestPreparation,
  type RequestResponseRecord,
  type RequestService,
  type RequestOriginator,
} from '../request-service.js';
import { resolveTarget } from '../target-resolver.js';
import { normalizeName } from '../domain/names.js';
import { IdentitySelectionError } from '../identity-context.js';
import { PreambleContentError } from '../domain/preamble.js';
import {
  assertTargetIdentityEvidence,
  identityAwareTmux,
  IdentityServiceError,
} from '../identity-service.js';
import { RequestInputError, validateRequestMessage } from '../domain/request-content.js';
import { TmuxDeliveryError } from '../message-delivery.js';
import { buildDurableReplyInstruction } from '../talk-instruction.js';
import {
  isValidObserverTimeoutSeconds,
  isValidPollIntervalSeconds,
  isValidTimerDelayMs,
} from '../domain/interaction-limits.js';

export interface TalkRuntime {
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

interface TalkCorrelation {
  readonly requestId: string;
  readonly target: string;
  readonly pane: string;
  readonly identity?: { readonly name: string; readonly canonicalName: string };
}

function sleepMs(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function monotonicNow(): number {
  return performance.now();
}

function makeRequestId(): string {
  return `req_${crypto.randomUUID()}`;
}

function correlationDocument(correlation: TalkCorrelation): Record<string, unknown> {
  return {
    requestId: correlation.requestId,
    target: correlation.target,
    pane: correlation.pane,
    ...(correlation.identity && { identity: correlation.identity }),
  };
}

function inspectionGuidance(correlation: TalkCorrelation): string {
  return `Inspect with 'tmt result ${correlation.requestId}' and 'tmt check ${correlation.target}' before deciding whether to retry.`;
}

function resultGuidance(correlation: TalkCorrelation): string {
  return `Retrieve later with 'tmt result ${correlation.requestId}'.`;
}

function failSend(ctx: Context, correlation: TalkCorrelation, error: unknown): never {
  const detail =
    error instanceof TmuxDeliveryError
      ? {
          code: error.code,
          message: error.message,
          stage: error.stage,
          suggestion: inspectionGuidance(correlation),
        }
      : {
          code: 'DELIVERY_UNCERTAIN',
          message: 'Message delivery is uncertain; inspect the target pane before retrying.',
          stage: 'unknown',
          suggestion: inspectionGuidance(correlation),
        };
  if (ctx.flags.json) ctx.ui.json({ ...correlationDocument(correlation), error: detail });
  else ctx.ui.error(`${detail.message} ${detail.suggestion}`);
  return ctx.exit(ExitCodes.ERROR);
}

function failPreamble(ctx: Context, error: unknown): never {
  const code =
    error instanceof IdentitySelectionError || error instanceof PreambleContentError
      ? error.code
      : 'PREAMBLE_ERROR';
  const publicCode =
    code === 'NAME_NOT_FOUND' ||
    code === 'PREAMBLE_INPUT_INVALID' ||
    code === 'PREAMBLE_INPUT_TOO_LARGE'
      ? code
      : 'PREAMBLE_ERROR';
  const message =
    error instanceof Error ? error.message : 'Could not access identity preamble state.';
  if (ctx.flags.json) ctx.ui.json({ error: { code: publicCode, message } });
  else ctx.ui.error(message);
  return ctx.exit(publicCode === 'NAME_NOT_FOUND' ? ExitCodes.NAME_NOT_FOUND : ExitCodes.ERROR);
}

function failRequestState(
  ctx: Context,
  correlation: TalkCorrelation,
  possibleDelivery: boolean,
  cause?: unknown,
  operation: 'persist' | 'access' = 'persist'
): never {
  const detail = {
    code: 'REQUEST_STATE_ERROR',
    message:
      operation === 'access'
        ? 'Request state could not be read after transport; delivery may have occurred.'
        : possibleDelivery
          ? 'Request state could not be persisted after transport; delivery may have occurred.'
          : 'Request state could not be persisted before transport; no message was sent.',
    suggestion: possibleDelivery
      ? inspectionGuidance(correlation)
      : 'Fix the request state database before retrying.',
  };
  if (ctx.flags.json) ctx.ui.json({ ...correlationDocument(correlation), error: detail });
  else ctx.ui.error(`${detail.message} ${detail.suggestion}`);
  if (cause && ctx.flags.debug) console.error('[DEBUG] Request state failure:', cause);
  return ctx.exit(ExitCodes.ERROR);
}

function failPreparation(ctx: Context, correlation: TalkCorrelation): never {
  const detail = {
    code: 'ERROR',
    message: 'Could not prepare durable response instructions.',
  };
  if (ctx.flags.json) ctx.ui.json({ ...correlationDocument(correlation), error: detail });
  else ctx.ui.error(`${detail.message} Request: ${correlation.requestId}.`);
  return ctx.exit(ExitCodes.ERROR);
}

function failTiming(ctx: Context, message: string): never {
  if (ctx.flags.json) ctx.ui.json({ error: { code: 'CONFIG_ERROR', message } });
  else ctx.ui.error(message);
  return ctx.exit(ExitCodes.ERROR);
}

function failRequestInput(ctx: Context, error: RequestInputError): never {
  if (ctx.flags.json) ctx.ui.json({ error: { code: error.code, message: error.message } });
  else ctx.ui.error(error.message);
  return ctx.exit(ExitCodes.ERROR);
}

function failIdentity(ctx: Context, error: unknown): never {
  const detail =
    error instanceof IdentitySelectionError || error instanceof IdentityServiceError
      ? { code: error.code, message: error.message }
      : { code: 'RECONCILIATION_FAILED', message: 'Could not verify request identity context.' };
  if (ctx.flags.json) ctx.ui.json({ error: detail });
  else ctx.ui.error(detail.message);
  return ctx.exit(detail.code === 'NAME_NOT_FOUND' ? ExitCodes.NAME_NOT_FOUND : ExitCodes.ERROR);
}

function resolveOriginator(ctx: Context, selector: TalkRequest['originator']): RequestOriginator {
  const resolution = ctx.identityService.resolveIdentity(selector);
  if (resolution.status === 'bound') {
    return { kind: selector ? 'explicit' : 'verified', identityId: resolution.identity.id };
  }
  if (resolution.status === 'not-found') {
    throw new IdentitySelectionError(
      'NAME_NOT_FOUND',
      `Identity '${selector?.value}' was not found.`
    );
  }
  if (resolution.status === 'ambiguous') {
    throw new IdentitySelectionError(
      'IDENTITY_AMBIGUOUS',
      'Current pane has ambiguous identity binding.'
    );
  }
  // Unlike role access, talk permits an anonymous caller. This is attribution,
  // not a remote authentication boundary or an implicit identity-creation path.
  return { kind: 'unknown' };
}

interface PreparedMessage {
  readonly message: string;
  readonly preamble?: {
    readonly identityId: string;
    readonly every: number;
    readonly content: string;
  };
}

function prepareMessage(
  message: string,
  identityName: string | undefined,
  ctx: Context
): PreparedMessage {
  const { config, flags } = ctx;
  if (config.preambleMode === 'disabled' || flags.noPreamble) return { message };

  const preambleEvery = config.defaults.preambleEvery;
  if (preambleEvery <= 0 || !identityName) return { message };
  if (!ctx.preambleService) throw new Error('Preamble service is unavailable.');

  const result = ctx.preambleService.show(identityName);
  const preamble = result.preamble?.content;
  if (!preamble) return { message };

  return {
    message,
    preamble: { identityId: result.identity.id, every: preambleEvery, content: preamble },
  };
}

function composeMessage(prepared: PreparedMessage, injectPreamble: boolean): string {
  if (!injectPreamble || !prepared.preamble) return prepared.message;
  return `[SYSTEM: ${prepared.preamble.content}]\n\n${prepared.message}`;
}

function validateTiming(
  waitEnabled: boolean,
  timeoutSeconds: number,
  pollIntervalSeconds: number,
  enterDelayMs: number
): void {
  if (waitEnabled && !isValidObserverTimeoutSeconds(timeoutSeconds)) {
    throw new Error('Talk timeout must be finite, positive, and no greater than 24 hours.');
  }
  if (waitEnabled && !isValidPollIntervalSeconds(pollIntervalSeconds)) {
    throw new Error('The configured poll interval must be finite and positive.');
  }
  if (!isValidTimerDelayMs(enterDelayMs)) {
    throw new Error(
      'The configured paste-enter delay must be finite, non-negative, and within the timer limit.'
    );
  }
}

function validateDelay(delaySeconds: number | undefined): void {
  if (delaySeconds === undefined) return;
  if (!isValidTimerDelayMs(delaySeconds * 1000)) {
    throw new Error('Talk delay must be finite, non-negative, and within the timer limit.');
  }
}

function requestExpiryMs(wait: boolean, timeoutSeconds: number, enterDelayMs: number): number {
  const timeoutMs = wait ? Math.ceil(timeoutSeconds * 1000) : 0;
  const delayMs = Math.ceil(enterDelayMs);
  if (!Number.isSafeInteger(timeoutMs) || !Number.isSafeInteger(delayMs)) {
    throw new Error('The request timing budget is outside the supported range.');
  }
  const budgetMs = timeoutMs + delayMs + 1000;
  const retentionMs = Math.max(60 * 60 * 1000, wait ? budgetMs : delayMs + 1000);
  const nowMs = Date.now();
  if (!Number.isSafeInteger(retentionMs) || !Number.isSafeInteger(nowMs + retentionMs)) {
    throw new Error('The request expiry is outside the supported range.');
  }
  return nowMs + retentionMs;
}

function responseDocument(
  correlation: TalkCorrelation,
  response: RequestResponseRecord
): Record<string, unknown> {
  return {
    ...correlationDocument(correlation),
    status: 'completed',
    response: response.body,
    bodyBytes: response.bodyBytes,
    submittedAtMs: response.submittedAtMs,
  };
}

function timeoutMessage(agentName: string, timeoutSeconds: number): string {
  return `Timed out waiting for ${agentName} after ${timeoutSeconds}s`;
}

export async function cmdTalk(
  ctx: Context,
  request: TalkRequest,
  runtime: TalkRuntime = {}
): Promise<void> {
  const { message } = request;
  const target = request.target.value;
  const { ui, config, tmux, flags, exit } = ctx;
  const waitEnabled = !flags.detach;
  const timeoutSeconds = flags.timeout ?? config.defaults.timeout;
  const pollIntervalSeconds = config.defaults.pollInterval;
  const enterDelayMs = config.defaults.pasteEnterDelayMs;
  const now = runtime.now ?? monotonicNow;
  const sleep = runtime.sleep ?? sleepMs;

  try {
    validateDelay(flags.delay);
    validateTiming(waitEnabled, timeoutSeconds, pollIntervalSeconds, enterDelayMs);
  } catch (error) {
    return failTiming(ctx, error instanceof Error ? error.message : 'Invalid talk timing.');
  }

  try {
    validateRequestMessage(message);
  } catch (error) {
    if (error instanceof RequestInputError) return failRequestInput(ctx, error);
    throw error;
  }

  let resolution;
  try {
    resolution = resolveTarget(identityAwareTmux(tmux, ctx.identityService), target);
  } catch (error) {
    return failIdentity(ctx, error);
  }
  if (!resolution.ok) {
    if (flags.json) ui.json({ error: resolution.error });
    else ui.error(resolution.error.message);
    return exit(
      resolution.error.code === 'NAME_NOT_FOUND'
        ? ExitCodes.NAME_NOT_FOUND
        : ExitCodes.PANE_NOT_FOUND
    );
  }

  let originator: RequestOriginator;
  try {
    originator = resolveOriginator(ctx, request.originator);
  } catch (error) {
    return failIdentity(ctx, error);
  }

  const pane = resolution.value.paneId;
  const agentName = resolution.value.identity?.name ?? pane;
  const identity = resolution.value.identity
    ? {
        name: resolution.value.identity.name,
        canonicalName:
          resolution.value.identity.canonicalName || normalizeName(resolution.value.identity.name),
      }
    : undefined;
  const requestId = makeRequestId();
  const correlation: TalkCorrelation = { requestId, target, pane, ...(identity && { identity }) };

  if (flags.delay && flags.delay > 0) await sleep(flags.delay * 1000);

  let preparedMessage: PreparedMessage;
  try {
    preparedMessage = prepareMessage(message, resolution.value.identity?.name, ctx);
  } catch (error) {
    failPreamble(ctx, error);
  }

  let endpoint;
  try {
    if (!tmux.getEndpointSnapshot) throw new Error('Tmux endpoint evidence is unavailable.');
    const snapshot = tmux.getEndpointSnapshot({ paneIds: [pane] });
    if (resolution.value.identity) {
      assertTargetIdentityEvidence(resolution.value.identity, snapshot);
    }
    endpoint = endpointFromSnapshot(snapshot, pane);
  } catch (error) {
    if (error instanceof IdentityServiceError) return failIdentity(ctx, error);
    return failRequestState(ctx, correlation, false, error);
  }

  let requestService: RequestService;
  try {
    requestService = ctx.requestService;
  } catch (error) {
    return failRequestState(ctx, correlation, false, error);
  }

  let preparation: RequestPreparation;
  try {
    preparation = requestService.prepare({
      requestId,
      message,
      originator,
      ...(resolution.value.identity?.evidence && {
        recipientIdentityId: resolution.value.identity.evidence.identity.id,
      }),
      endpoint,
      wait: waitEnabled,
      expiresAtMs: requestExpiryMs(waitEnabled, timeoutSeconds, enterDelayMs),
      ...(preparedMessage.preamble && {
        preamble: {
          identityId: preparedMessage.preamble.identityId,
          every: preparedMessage.preamble.every,
        },
      }),
    });
  } catch (error) {
    if (error instanceof RequestInputError) return failRequestInput(ctx, error);
    return failRequestState(ctx, correlation, false, error);
  }

  const releasePrepared = (): unknown => {
    let cleanupError: unknown;
    try {
      requestService.settle(preparation.attemptId, 'definitely_failed');
    } catch (error) {
      cleanupError = error;
      if (flags.debug) console.error('[DEBUG] Failed to refund prepared request:', error);
    }
    if (waitEnabled) {
      try {
        requestService.releaseWait(preparation.attemptId);
      } catch (error) {
        cleanupError ??= error;
        if (flags.debug) console.error('[DEBUG] Request waiter cleanup failed:', error);
      }
    }
    return cleanupError;
  };

  let receipt: string;
  let instruction: string;
  try {
    const receiptValue: ReplyReceipt = {
      version: 1,
      requestId,
      attemptId: preparation.attemptId,
      endpoint,
    };
    receipt = encodeReplyReceipt(receiptValue);
    instruction = buildDurableReplyInstruction(requestId, receipt);
  } catch {
    const cleanupError = releasePrepared();
    if (cleanupError) return failRequestState(ctx, correlation, false, cleanupError);
    return failPreparation(ctx, correlation);
  }

  if (waitEnabled && preparation.previousRequestId && !flags.json && !flags.force) {
    ui.warn(
      `Another recent request exists for '${agentName}' (id: ${preparation.previousRequestId}). Input processing is not serialized; durable results remain associated by request ID.`
    );
  }

  const fullMessage = `${composeMessage(preparedMessage, preparation.injectPreamble)}\n\n${instruction}`;
  let waitReleased = false;

  const releaseWait = (possibleDelivery: boolean): void => {
    if (!waitEnabled || waitReleased) return;
    waitReleased = true;
    try {
      requestService.releaseWait(preparation.attemptId);
    } catch (error) {
      failRequestState(ctx, correlation, possibleDelivery, error);
    }
  };

  const settle = (
    outcome: 'sent' | 'uncertain' | 'definitely_failed',
    possibleDelivery: boolean
  ): void => {
    try {
      requestService.settle(preparation.attemptId, outcome);
    } catch (error) {
      if (possibleDelivery && waitEnabled && !waitReleased) {
        waitReleased = true;
        try {
          requestService.releaseWait(preparation.attemptId);
        } catch (cleanupError) {
          if (flags.debug) console.error('[DEBUG] Request waiter cleanup failed:', cleanupError);
        }
      }
      failRequestState(ctx, correlation, possibleDelivery, error);
    }
  };

  const send = (): void => {
    try {
      requestService.beginSend(preparation.attemptId);
    } catch (error) {
      try {
        requestService.settle(preparation.attemptId, 'definitely_failed');
      } catch (cleanupError) {
        if (flags.debug) console.error('[DEBUG] Failed to refund prepared request:', cleanupError);
      }
      releaseWait(false);
      failRequestState(ctx, correlation, false, error);
    }

    try {
      tmux.send(pane, fullMessage, { enterDelayMs });
    } catch (error) {
      settle('uncertain', true);
      releaseWait(true);
      failSend(ctx, correlation, error);
    }
    settle('sent', true);
  };

  if (!waitEnabled) {
    send();
    if (flags.json) ui.json({ ...correlationDocument(correlation), status: 'sent' });
    else {
      ui.success(`Sent request ${requestId} to ${target} (${pane}).`);
      ui.info(resultGuidance(correlation));
    }
    return;
  }

  // The deadline starts before beginSend and transport. It is never reset
  // after Enter, so synchronous transport time counts against the observer.
  let deadline = Number.NaN;
  let interrupted = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let wakePoll: (() => void) | undefined;
  const onSigint = (): void => {
    interrupted = true;
    wakePoll?.();
  };
  const waitForPoll = (delayMs: number): Promise<void> => {
    if (runtime.sleep) return sleep(delayMs);
    return new Promise((resolve) => {
      const finish = (): void => {
        if (pollTimer === undefined) return;
        clearTimeout(pollTimer);
        pollTimer = undefined;
        wakePoll = undefined;
        resolve();
      };
      wakePoll = finish;
      pollTimer = setTimeout(finish, delayMs);
    });
  };

  const interrupt = (): never => {
    releaseWait(true);
    if (flags.json) {
      ui.json({
        ...correlationDocument(correlation),
        error: { code: 'INTERRUPTED', message: 'Interrupted while waiting for a durable reply.' },
      });
    } else {
      ui.error(
        `Interrupted while waiting for request ${requestId}. ${inspectionGuidance(correlation)}`
      );
    }
    return exit(ExitCodes.ERROR);
  };

  const timeout = (): never => {
    releaseWait(true);
    const messageText = timeoutMessage(agentName, timeoutSeconds);
    const error = { code: 'TIMEOUT', message: messageText };
    if (flags.json) ui.json({ ...correlationDocument(correlation), status: 'timeout', error });
    else {
      ui.error(
        `${messageText}. Request ${requestId} remains available for a late reply. ${resultGuidance(correlation)} ${inspectionGuidance(correlation)}`
      );
    }
    return exit(ExitCodes.TIMEOUT);
  };

  process.once('SIGINT', onSigint);
  try {
    // Set the observer bound immediately before beginSend and transport. It is
    // never reset after Enter, so synchronous transport time counts.
    deadline = now() + timeoutSeconds * 1000;
    send();

    while (true) {
      if (interrupted) interrupt();
      if (now() >= deadline) timeout();

      // A snapshot is valid only while the observer is within its monotonic
      // deadline. A synchronous read that crosses the bound loses.
      let response: RequestResponseRecord | undefined;
      try {
        response = requestService.getResponse(requestId);
      } catch (error) {
        releaseWait(true);
        failRequestState(ctx, correlation, true, error, 'access');
      }
      if (now() >= deadline) timeout();
      if (response) {
        releaseWait(true);
        if (flags.json) ui.json(responseDocument(correlation, response));
        else {
          ui.success(`Completed request ${requestId} for ${agentName} (${pane}).`);
          ui.info(response.body);
          ui.info(resultGuidance(correlation));
        }
        return;
      }

      const remainingMs = deadline - now();
      if (remainingMs <= 0) timeout();
      await waitForPoll(Math.min(pollIntervalSeconds * 1000, remainingMs));
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    if (pollTimer !== undefined) {
      clearTimeout(pollTimer);
      pollTimer = undefined;
      wakePoll = undefined;
    }
    if (waitEnabled && !waitReleased) {
      waitReleased = true;
      try {
        requestService.releaseWait(preparation.attemptId);
      } catch (error) {
        if (flags.debug) console.error('[DEBUG] Request waiter cleanup failed:', error);
      }
    }
  }
}
