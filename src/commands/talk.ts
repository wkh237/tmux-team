// ─────────────────────────────────────────────────────────────
// talk command - send a message to one resolved pane
// ─────────────────────────────────────────────────────────────

import type { Context } from '../types.js';
import type { WaitResult } from '../types.js';
import { ExitCodes } from '../exits.js';
import { colors } from '../ui.js';
import crypto from 'node:crypto';
import {
  endpointFromSnapshot,
  type RequestPreparation,
  type RequestService,
} from '../request-service.js';
import { resolveTarget } from '../target-resolver.js';
import { normalizeName } from '../domain/names.js';
import { IdentitySelectionError } from '../identity-context.js';
import { PreambleContentError } from '../domain/preamble.js';
import { identityAwareTmux } from '../identity-service.js';
import { TmuxDeliveryError } from '../message-delivery.js';

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function failSend(ctx: Context, pane: string, error: unknown): never {
  if (error instanceof TmuxDeliveryError) {
    const detail = {
      code: error.code,
      message: error.message,
      stage: error.stage,
      suggestion: 'Inspect the target pane before retrying.',
    };
    if (ctx.flags.json) ctx.ui.json({ error: detail });
    else ctx.ui.error(`${detail.message} ${detail.suggestion}`);
    return ctx.exit(ExitCodes.ERROR);
  }

  const detail = {
    code: 'ERROR',
    message: `Failed to send to pane ${pane}. Is tmux running?`,
    suggestion: 'Delivery may have occurred; inspect the target pane before retrying.',
  };
  if (ctx.flags.json) ctx.ui.json({ error: detail });
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

function failRequestState(ctx: Context, possibleDelivery: boolean, cause?: unknown): never {
  const detail = {
    code: 'REQUEST_STATE_ERROR',
    message: possibleDelivery
      ? 'Request state could not be persisted after transport; delivery may have occurred. Do not retry until you inspect the target pane.'
      : 'Request state could not be persisted before transport; no message was sent. Fix the request state database before retrying.',
    suggestion: possibleDelivery
      ? 'Inspect the target pane before retrying.'
      : 'Fix the request state database before retrying.',
  };
  if (ctx.flags.json) ctx.ui.json({ error: detail });
  else ctx.ui.error(`${detail.message} ${detail.suggestion}`);
  if (cause && ctx.flags.debug) {
    console.error('[DEBUG] Request state failure:', cause);
  }
  return ctx.exit(ExitCodes.ERROR);
}

/**
 * Clean Gemini CLI response by removing UI artifacts.
 */
function cleanGeminiResponse(response: string): string {
  return response
    .split('\n')
    .filter((line) => {
      // Remove "Responding with..." status lines
      if (/Responding with\s+\S+/.test(line)) return false;
      // Remove empty lines with only whitespace/box chars
      if (/^[\s█]*$/.test(line)) return false;
      return true;
    })
    .map((line) => line.replace(/^[\s█]*✦?\s*/, '').replace(/[\s█]*$/, ''))
    .join('\n')
    .trim();
}

function makeRequestId(): string {
  return `req_${crypto.randomUUID()}`;
}

function makeNonce(): string {
  return crypto.randomBytes(2).toString('hex');
}

function makeEndMarker(nonce: string): string {
  return `RESPONSE-END-${nonce}`;
}

/**
 * Build a regex to match the end marker case-insensitively.
 * This handles agents that might print the marker in different case.
 * Also tolerates optional surrounding dashes for backwards compatibility.
 */
function makeEndMarkerRegex(nonce: string): RegExp {
  return new RegExp(`-{0,3}RESPONSE-END-${nonce}-{0,3}`, 'i');
}

/**
 * Build the end marker instruction showing the exact format with a placeholder.
 *
 * The instruction uses "xxxx" as a placeholder, so the literal marker with the
 * actual nonce can ONLY appear if the agent prints it. This avoids false-positive
 * detection when the instruction is still visible in scrollback.
 */
function makeEndMarkerInstruction(nonce: string): string {
  return `When done, output exactly: RESPONSE-END-xxxx (where xxxx = ${nonce})`;
}

/**
 * Check if a line is the instruction line (not the actual marker).
 * The instruction line contains both the nonce AND instruction keywords.
 */
function isInstructionLine(line: string, nonce: string): boolean {
  const lowerLine = line.toLowerCase();
  return (
    lowerLine.includes(`response-end-${nonce.toLowerCase()}`) &&
    (lowerLine.includes('output exactly') || lowerLine.includes('where xxxx'))
  );
}

/**
 * Check if output contains an actual end marker (not just the instruction).
 * Returns true only if there's a line with the marker that isn't the instruction.
 */
function hasActualEndMarker(output: string, nonce: string, endMarkerRegex: RegExp): boolean {
  const lines = output.split('\n');
  return lines.some((line) => endMarkerRegex.test(line) && !isInstructionLine(line, nonce));
}

function renderWaitLine(agent: string, elapsedSeconds: number): string {
  const s = Math.max(0, Math.floor(elapsedSeconds));
  return `⏳ Waiting for ${agent}... (${s}s)`;
}

/**
 * Extract partial response from output when end marker is not found.
 * Used to capture whatever the agent wrote before timeout.
 *
 * We look for the instruction line (contains instruction keywords like "output exactly")
 * and extract content after it. Falls back to last N lines if instruction not found.
 */
function extractPartialResponse(
  output: string,
  endMarker: string,
  maxLines: number
): string | null {
  const lines = output.split('\n');

  // Extract nonce from endMarker (format: RESPONSE-END-xxxx)
  // Use case-insensitive match to be flexible with nonce format changes
  const nonceMatch = endMarker.match(/RESPONSE-END-([a-f0-9]+)/i);
  if (!nonceMatch) return null;
  const nonce = nonceMatch[1];

  // Find the instruction line using consistent detection
  const instructionLineIndex = lines.findIndex((line) => isInstructionLine(line, nonce));

  let responseLines: string[];
  if (instructionLineIndex !== -1) {
    // Extract lines after instruction
    responseLines = lines.slice(instructionLineIndex + 1);
  } else {
    // Fallback: just take the output (no instruction found in view)
    responseLines = lines;
  }

  const limitedLines = responseLines.slice(-maxLines); // Take last N lines

  const partial = limitedLines.join('\n').trim();
  return partial || null;
}
// Expandable capture extraction
// ─────────────────────────────────────────────────────────────

interface ExtractResult {
  response: string;
  truncated: boolean;
}

/**
 * Extract response with expandable capture.
 *
 * When the instruction line is not found in the initial capture (response too long),
 * retry with progressively larger captures up to maxCaptureLines.
 */
function extractWithExpandableCapture(
  tmux: Context['tmux'],
  pane: string,
  nonce: string,
  endMarkerRegex: RegExp,
  initialCapture: string,
  captureLines: number,
  maxCaptureLines: number,
  responseLines: number,
  debug?: boolean
): ExtractResult {
  let output = initialCapture;
  let currentCaptureLines = captureLines;
  let truncated = false;

  // Try extraction with progressively larger captures
  while (true) {
    const lines = output.split('\n');

    // Find end marker line (case-insensitive, last occurrence, excluding instruction lines)
    let endMarkerLineIndex = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (endMarkerRegex.test(lines[i]) && !isInstructionLine(lines[i], nonce)) {
        endMarkerLineIndex = i;
        break;
      }
    }

    if (endMarkerLineIndex === -1) {
      // No marker found - shouldn't happen if called correctly
      return { response: '', truncated: true };
    }

    // Find instruction line using consistent detection
    const instructionLineIndex = lines.findIndex((line) => isInstructionLine(line, nonce));

    if (instructionLineIndex !== -1 && instructionLineIndex < endMarkerLineIndex) {
      // Instruction visible: extract from after instruction to marker
      const response = lines
        .slice(instructionLineIndex + 1, endMarkerLineIndex)
        .join('\n')
        .trim();
      return { response, truncated: false };
    }

    // Instruction not found - try larger capture if possible
    if (currentCaptureLines >= maxCaptureLines) {
      // Already at max, fall back to N lines before marker
      if (debug) {
        console.error(
          `[DEBUG] Instruction line not found after max capture (${maxCaptureLines} lines), falling back`
        );
      }
      truncated = true;
      const startLine = Math.max(0, endMarkerLineIndex - responseLines);
      const response = lines.slice(startLine, endMarkerLineIndex).join('\n').trim();
      return { response, truncated };
    }

    // Double capture size and retry
    currentCaptureLines = Math.min(currentCaptureLines * 2, maxCaptureLines);
    if (debug) {
      console.error(`[DEBUG] Expanding capture to ${currentCaptureLines} lines`);
    }

    try {
      output = tmux.capture(pane, currentCaptureLines);
    } catch {
      // Capture failed, use what we have
      truncated = true;
      const startLine = Math.max(0, endMarkerLineIndex - responseLines);
      const response = lines.slice(startLine, endMarkerLineIndex).join('\n').trim();
      return { response, truncated };
    }
  }
}

/**
 * Build the final message with optional preamble.
 * Format: [SYSTEM: <preamble>]\n\n<message>
 *
 * Preamble injection frequency is controlled by preambleEvery config.
 * Default: inject every 3 messages per agent to save tokens.
 */
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

  // Skip preamble if disabled or --no-preamble flag
  if (config.preambleMode === 'disabled' || flags.noPreamble) {
    return { message };
  }

  // preambleEvery = 0 disables lookup and counter mutation entirely.
  const preambleEvery = config.defaults.preambleEvery;
  if (preambleEvery <= 0) return { message };

  // Direct pane targets without a durable identity have no preamble owner.
  if (!identityName) return { message };
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

function requestExpiryMs(wait: boolean, timeoutSeconds: number, enterDelayMs: number): number {
  if (!Number.isFinite(enterDelayMs) || enterDelayMs < 0) {
    throw new Error('The configured paste-enter delay must be a finite non-negative number.');
  }
  if (wait && (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0)) {
    throw new Error('The wait timeout must be a finite non-negative number.');
  }

  const nowMs = Date.now();
  const timeoutMs = wait ? Math.ceil(timeoutSeconds * 1000) : 0;
  const delayMs = Math.ceil(enterDelayMs);
  const budgetMs = timeoutMs + delayMs + 1000;
  const retentionMs = Math.max(60 * 60 * 1000, wait ? budgetMs : delayMs + 1000);
  if (!Number.isSafeInteger(timeoutMs) || !Number.isSafeInteger(delayMs)) {
    throw new Error('The request timing budget is outside the supported range.');
  }
  if (!Number.isSafeInteger(retentionMs) || !Number.isSafeInteger(nowMs + retentionMs)) {
    throw new Error('The request expiry is outside the supported range.');
  }
  return nowMs + retentionMs;
}

export async function cmdTalk(ctx: Context, target: string, message: string): Promise<void> {
  const { ui, config, tmux, flags, exit } = ctx;
  const waitEnabled = Boolean(flags.wait) || config.mode === 'wait';
  const enterDelayMs = config.defaults.pasteEnterDelayMs;

  const runtimeTmux = identityAwareTmux(tmux, ctx.identityService);
  const resolution = resolveTarget(runtimeTmux, target);
  if (!resolution.ok) {
    if (flags.json) ui.json({ error: resolution.error });
    else ui.error(resolution.error.message);
    return exit(
      resolution.error.code === 'NAME_NOT_FOUND'
        ? ExitCodes.NAME_NOT_FOUND
        : ExitCodes.PANE_NOT_FOUND
    );
  }

  const pane = resolution.value.paneId;
  // Preserve identity-specific behavior (preambles and Gemini cleanup) while
  // allowing direct pane targets to address unnamed panes.
  const agentName = resolution.value.identity?.name ?? pane;
  const isGemini = normalizeName(agentName) === 'gemini';
  const identity = resolution.value.identity
    ? {
        name: resolution.value.identity.name,
        canonicalName:
          resolution.value.identity.canonicalName || normalizeName(resolution.value.identity.name),
      }
    : undefined;

  if (flags.delay && flags.delay > 0) {
    await sleepMs(flags.delay * 1000);
  }

  // Prepare once before either transport path or wait bookkeeping. A preamble
  // lookup failure must not be reported as a delivery failure or send raw input.
  let preparedMessage: PreparedMessage;
  try {
    preparedMessage = prepareMessage(message, resolution.value.identity?.name, ctx);
  } catch (error) {
    failPreamble(ctx, error);
  }
  const timeoutSeconds = flags.timeout ?? config.defaults.timeout;
  const requestId = makeRequestId();
  const nonce = waitEnabled ? makeNonce() : undefined;
  const endMarker = nonce ? makeEndMarker(nonce) : undefined;

  let endpoint;
  try {
    if (!tmux.getEndpointSnapshot) throw new Error('Tmux endpoint evidence is unavailable.');
    endpoint = endpointFromSnapshot(tmux.getEndpointSnapshot(), pane);
  } catch (error) {
    return failRequestState(ctx, false, error);
  }

  let requestService: RequestService;
  try {
    requestService = ctx.requestService;
  } catch (error) {
    return failRequestState(ctx, false, error);
  }

  let preparation: RequestPreparation;
  try {
    preparation = requestService.prepare({
      requestId,
      ...(nonce !== undefined && { nonce }),
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
    return failRequestState(ctx, false, error);
  }

  if (waitEnabled && preparation.previousRequestId && !flags.json && !flags.force) {
    ui.warn(
      `Another recent wait request exists for '${agentName}' (id: ${preparation.previousRequestId}). Results may interleave.`
    );
  }

  const messageWithPreamble = composeMessage(preparedMessage, preparation.injectPreamble);
  const fullMessage = waitEnabled
    ? `${messageWithPreamble}\n\n${makeEndMarkerInstruction(nonce!)}`
    : messageWithPreamble;

  let waitReleased = false;
  const releaseWait = (possibleDelivery: boolean): void => {
    if (!waitEnabled || waitReleased) return;
    waitReleased = true;
    try {
      requestService.releaseWait(preparation.attemptId);
    } catch (error) {
      failRequestState(ctx, possibleDelivery, error);
    }
  };

  const settle = (
    outcome: 'sent' | 'uncertain' | 'definitely_failed',
    possibleDelivery: boolean
  ): void => {
    try {
      requestService.settle(preparation.attemptId, outcome);
    } catch (error) {
      // Once transport may have run, release the waiter before reporting the
      // persistence failure. Cleanup is best effort and must not replace the
      // primary state error.
      if (possibleDelivery && waitEnabled && !waitReleased) {
        waitReleased = true;
        try {
          requestService.releaseWait(preparation.attemptId);
        } catch (cleanupError) {
          if (flags.debug) console.error('[DEBUG] Request waiter cleanup failed:', cleanupError);
        }
      }
      failRequestState(ctx, possibleDelivery, error);
    }
  };

  const beginSend = (): void => {
    try {
      requestService.beginSend(preparation.attemptId);
    } catch (error) {
      try {
        requestService.settle(preparation.attemptId, 'definitely_failed');
      } catch (cleanupError) {
        if (flags.debug) console.error('[DEBUG] Failed to refund prepared request:', cleanupError);
      }
      if (waitEnabled && !waitReleased) {
        waitReleased = true;
        try {
          requestService.releaseWait(preparation.attemptId);
        } catch (cleanupError) {
          if (flags.debug) console.error('[DEBUG] Request waiter cleanup failed:', cleanupError);
        }
      }
      failRequestState(ctx, false, error);
    }
  };

  if (!waitEnabled) {
    beginSend();
    try {
      tmux.send(pane, fullMessage, { enterDelayMs });
    } catch (error) {
      settle('uncertain', true);
      failSend(ctx, pane, error);
    }
    settle('sent', true);

    if (flags.json) {
      ui.json({ target, pane, ...(identity && { identity }), status: 'sent' });
    } else {
      console.log(`${colors.green('→')} Sent to ${colors.cyan(target)} (${pane})`);
    }
    return;
  }

  // Wait mode
  const waitNonce = nonce!;
  const waitEndMarker = endMarker!;
  const pollIntervalSeconds = Math.max(0.1, config.defaults.pollInterval);
  const captureLines = config.defaults.captureLines;

  const startedAt = Date.now();
  let lastNonTtyLogAt = 0;
  const isTTY = process.stdout.isTTY && !flags.json;

  // Debounce detection: wait for output to stabilize
  // Adaptive: for very short timeouts (testing), reduce debounce thresholds
  const timeoutMs = timeoutSeconds * 1000;
  const MIN_WAIT_MS = Math.min(3000, timeoutMs * 0.3); // Wait at least 3s or 30% of timeout
  const IDLE_THRESHOLD_MS = Math.min(3000, timeoutMs * 0.3); // Stable for 3s or 30% of timeout
  let lastOutput = '';
  let lastOutputChangeAt = Date.now();

  const onSigint = (): void => {
    releaseWait(true);
    if (!flags.json) process.stdout.write('\n');
    ui.error('Interrupted.');
    exit(ExitCodes.ERROR);
  };

  process.once('SIGINT', onSigint);

  try {
    beginSend();
    const msg = fullMessage;

    if (flags.debug) {
      console.error(`[DEBUG] Starting wait mode for ${agentName}`);
      console.error(`[DEBUG] End marker: ${endMarker}`);
      console.error(`[DEBUG] Message sent:\n${msg}`);
    }

    try {
      tmux.send(pane, msg, { enterDelayMs });
    } catch (error) {
      settle('uncertain', true);
      releaseWait(true);
      failSend(ctx, pane, error);
    }
    settle('sent', true);

    while (true) {
      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      if (elapsedSeconds >= timeoutSeconds) {
        // Capture partial response on timeout
        const responseLines = flags.lines ?? 100;
        let partialResponse: string | null = null;
        try {
          const output = tmux.capture(pane, captureLines);
          const extracted = extractPartialResponse(output, waitEndMarker, responseLines);
          if (extracted) {
            partialResponse = isGemini ? cleanGeminiResponse(extracted) : extracted;
          }
        } catch {
          // Ignore capture errors on timeout
        }

        if (isTTY) {
          process.stdout.write('\r' + ' '.repeat(80) + '\r');
        }

        releaseWait(true);

        if (flags.json) {
          ui.json({
            target,
            pane,
            ...(identity && { identity }),
            status: 'timeout',
            error: `Timed out waiting for ${agentName} after ${Math.floor(timeoutSeconds)}s`,
            requestId,
            nonce: waitNonce,
            endMarker: waitEndMarker,
            partialResponse,
          });
          exit(ExitCodes.TIMEOUT);
        }

        ui.error(`Timed out waiting for ${target} after ${Math.floor(timeoutSeconds)}s.`);
        if (partialResponse) {
          console.log();
          console.log(colors.yellow(`─── Partial response from ${agentName} (${pane}) ───`));
          console.log(partialResponse);
        }
        exit(ExitCodes.TIMEOUT);
      }

      if (!flags.json) {
        if (isTTY) {
          process.stdout.write('\r' + renderWaitLine(agentName, elapsedSeconds));
        } else if (flags.verbose || flags.debug) {
          // Non-TTY progress logs only with --verbose or --debug
          const now = Date.now();
          if (now - lastNonTtyLogAt >= 30000) {
            lastNonTtyLogAt = now;
            console.error(
              `[tmux-team] Waiting for ${target} (${Math.floor(elapsedSeconds)}s elapsed)`
            );
          }
        }
      }

      await sleepMs(pollIntervalSeconds * 1000);

      let output = '';
      try {
        output = tmux.capture(pane, captureLines);
      } catch {
        releaseWait(true);
        const error = {
          code: 'ERROR',
          message: `Failed to capture pane ${pane}. Is tmux running?`,
        };
        if (flags.json) ui.json({ error });
        else ui.error(error.message);
        exit(ExitCodes.ERROR);
      }

      // DEBUG: Log captured output
      if (flags.debug) {
        const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
        const firstIdx = output.indexOf(waitEndMarker);
        const lastIdx = output.lastIndexOf(waitEndMarker);
        console.error(`\n[DEBUG ${elapsedSec}s] Output: ${output.length} chars`);
        console.error(`[DEBUG ${elapsedSec}s] End marker: ${endMarker}`);
        console.error(`[DEBUG ${elapsedSec}s] First index: ${firstIdx}, Last index: ${lastIdx}`);
        console.error(
          `[DEBUG ${elapsedSec}s] Two markers found: ${firstIdx !== -1 && firstIdx !== lastIdx}`
        );

        // Show content around markers if found
        if (firstIdx !== -1) {
          const context = output.slice(
            Math.max(0, firstIdx - 50),
            firstIdx + waitEndMarker.length + 50
          );
          console.error(`[DEBUG ${elapsedSec}s] First marker context:\n---\n${context}\n---`);
        }
        if (lastIdx !== -1 && lastIdx !== firstIdx) {
          const context = output.slice(
            Math.max(0, lastIdx - 50),
            lastIdx + waitEndMarker.length + 50
          );
          console.error(`[DEBUG ${elapsedSec}s] Last marker context:\n---\n${context}\n---`);
        }

        // Show last 300 chars of output
        console.error(`[DEBUG ${elapsedSec}s] Output tail:\n${output.slice(-300)}`);
      }

      // Track output changes for debounce detection
      if (output !== lastOutput) {
        lastOutput = output;
        lastOutputChangeAt = Date.now();
      }

      const elapsedMs = Date.now() - startedAt;
      const idleMs = Date.now() - lastOutputChangeAt;

      // Find end marker (case-insensitive to handle agent variations)
      // Must be an actual marker line, not the instruction line
      const endMarkerRegex = makeEndMarkerRegex(waitNonce);
      const hasEndMarker = hasActualEndMarker(output, waitNonce, endMarkerRegex);

      // Completion conditions:
      // 1. Must wait at least MIN_WAIT_MS
      // 2. Must have end marker in output
      // 3. Output must be stable for IDLE_THRESHOLD_MS (debounce)
      if (elapsedMs < MIN_WAIT_MS || !hasEndMarker || idleMs < IDLE_THRESHOLD_MS) {
        if (flags.debug && hasEndMarker) {
          console.error(
            `[DEBUG] Marker found, waiting for debounce (elapsed: ${elapsedMs}ms, idle: ${idleMs}ms)`
          );
        }
        continue;
      }

      if (flags.debug) {
        console.error(`[DEBUG] Agent completed (elapsed: ${elapsedMs}ms, idle: ${idleMs}ms)`);
      }

      // Extract response with expandable capture (handles long responses)
      const responseLines = flags.lines ?? 100;
      const maxCaptureLines = config.defaults.maxCaptureLines;

      const { response: extractedResponse, truncated } = extractWithExpandableCapture(
        tmux,
        pane,
        waitNonce,
        endMarkerRegex,
        output,
        captureLines,
        maxCaptureLines,
        responseLines,
        flags.debug
      );

      // Clean Gemini CLI UI artifacts
      const response = isGemini ? cleanGeminiResponse(extractedResponse) : extractedResponse;

      if (!flags.json && isTTY) {
        process.stdout.write('\r' + ' '.repeat(80) + '\r');
      } else if (!flags.json) {
        // Ensure the next output starts on a new line
        process.stdout.write('\n');
      }

      releaseWait(true);

      const result: WaitResult = {
        requestId,
        nonce: waitNonce,
        endMarker: waitEndMarker,
        response,
      };
      if (flags.json) {
        ui.json({
          target,
          pane,
          ...(identity && { identity }),
          status: 'completed',
          truncated,
          ...result,
        });
      } else {
        if (truncated) {
          ui.warn('Response may be truncated (instruction line not found in scrollback)');
        }
        console.log(colors.cyan(`─── Response from ${agentName} (${pane}) ───`));
        console.log(response);
      }
      return;
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    if (waitEnabled && !waitReleased) {
      waitReleased = true;
      try {
        requestService.releaseWait(preparation.attemptId);
      } catch (error) {
        // Preserve an unexpected primary failure; cleanup is retried by the
        // retention/expiry path when the request state service is available.
        if (flags.debug) console.error('[DEBUG] Request waiter cleanup failed:', error);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
