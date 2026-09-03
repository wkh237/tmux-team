// ─────────────────────────────────────────────────────────────
// talk command - send a message to one resolved pane
// ─────────────────────────────────────────────────────────────

import type { Context } from '../types.js';
import type { WaitResult } from '../types.js';
import { ExitCodes } from '../exits.js';
import { colors } from '../ui.js';
import crypto from 'crypto';
import {
  cleanupState,
  clearActiveRequest,
  setActiveRequest,
  incrementPreambleCounter,
} from '../state.js';
import { resolveTarget } from '../target-resolver.js';
import { normalizeName } from '../domain/names.js';
import { identityAwareTmux } from '../identity-service.js';

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  return `req_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
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
function buildMessage(message: string, agentName: string, ctx: Context): string {
  const { config, flags, paths } = ctx;

  // Skip preamble if disabled or --no-preamble flag
  if (config.preambleMode === 'disabled' || flags.noPreamble) {
    return message;
  }

  // Get agent-specific preamble
  const agentConfig =
    config.agents[agentName] ??
    Object.entries(config.agents).find(
      ([name]) => normalizeName(name) === normalizeName(agentName)
    )?.[1];
  const preamble = agentConfig?.preamble;

  if (!preamble) {
    return message;
  }

  // Check preamble frequency (preambleEvery: 0 means never, 1 means always)
  const preambleEvery = config.defaults.preambleEvery;
  if (preambleEvery <= 0) {
    // preambleEvery = 0 means never inject (equivalent to disabled for this agent)
    return message;
  }

  // Increment counter and check if we should inject preamble
  // Inject on message 1, 1+N, 1+2N, ... where N = preambleEvery
  const count = incrementPreambleCounter(paths, agentName);
  const shouldInject = (count - 1) % preambleEvery === 0;

  if (!shouldInject) {
    return message;
  }

  return `[SYSTEM: ${preamble}]\n\n${message}`;
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

  if (!waitEnabled) {
    try {
      // Build message with preamble, then apply Gemini filter
      const msg = buildMessage(message, agentName, ctx);
      tmux.send(pane, msg, { enterDelayMs });

      if (flags.json) {
        ui.json({ target, pane, ...(identity && { identity }), status: 'sent' });
      } else {
        console.log(`${colors.green('→')} Sent to ${colors.cyan(target)} (${pane})`);
      }
      return;
    } catch {
      const error = { code: 'ERROR', message: `Failed to send to pane ${pane}. Is tmux running?` };
      if (flags.json) ui.json({ error });
      else ui.error(error.message);
      exit(ExitCodes.ERROR);
    }
  }

  // Wait mode
  const timeoutSeconds = flags.timeout ?? config.defaults.timeout;
  const pollIntervalSeconds = Math.max(0.1, config.defaults.pollInterval);
  const captureLines = config.defaults.captureLines;

  const requestId = makeRequestId();
  const nonce = makeNonce();
  const endMarker = makeEndMarker(nonce);

  // Build message with preamble and end marker instruction
  // Note: instruction doesn't contain literal marker to prevent false-positive detection
  const messageWithPreamble = buildMessage(message, agentName, ctx);
  const fullMessage = `${messageWithPreamble}\n\n${makeEndMarkerInstruction(nonce)}`;

  // Best-effort cleanup and soft-lock warning
  const state = cleanupState(ctx.paths, 60 * 60); // 1 hour TTL
  const existing = state.requests[pane];
  if (existing && !flags.json && !flags.force) {
    ui.warn(
      `Another recent wait request exists for '${agentName}' (id: ${existing.id}). Results may interleave.`
    );
  }

  setActiveRequest(ctx.paths, pane, { id: requestId, nonce, pane, startedAtMs: Date.now() });

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
    clearActiveRequest(ctx.paths, pane, requestId);
    if (!flags.json) process.stdout.write('\n');
    ui.error('Interrupted.');
    exit(ExitCodes.ERROR);
  };

  process.once('SIGINT', onSigint);

  try {
    const msg = fullMessage;

    if (flags.debug) {
      console.error(`[DEBUG] Starting wait mode for ${agentName}`);
      console.error(`[DEBUG] End marker: ${endMarker}`);
      console.error(`[DEBUG] Message sent:\n${msg}`);
    }

    tmux.send(pane, msg, { enterDelayMs });

    while (true) {
      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      if (elapsedSeconds >= timeoutSeconds) {
        clearActiveRequest(ctx.paths, pane, requestId);

        // Capture partial response on timeout
        const responseLines = flags.lines ?? 100;
        let partialResponse: string | null = null;
        try {
          const output = tmux.capture(pane, captureLines);
          const extracted = extractPartialResponse(output, endMarker, responseLines);
          if (extracted) {
            partialResponse = isGemini ? cleanGeminiResponse(extracted) : extracted;
          }
        } catch {
          // Ignore capture errors on timeout
        }

        if (isTTY) {
          process.stdout.write('\r' + ' '.repeat(80) + '\r');
        }

        if (flags.json) {
          ui.json({
            target,
            pane,
            ...(identity && { identity }),
            status: 'timeout',
            error: `Timed out waiting for ${agentName} after ${Math.floor(timeoutSeconds)}s`,
            requestId,
            nonce,
            endMarker,
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
        clearActiveRequest(ctx.paths, pane, requestId);
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
        const firstIdx = output.indexOf(endMarker);
        const lastIdx = output.lastIndexOf(endMarker);
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
            firstIdx + endMarker.length + 50
          );
          console.error(`[DEBUG ${elapsedSec}s] First marker context:\n---\n${context}\n---`);
        }
        if (lastIdx !== -1 && lastIdx !== firstIdx) {
          const context = output.slice(Math.max(0, lastIdx - 50), lastIdx + endMarker.length + 50);
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
      const endMarkerRegex = makeEndMarkerRegex(nonce);
      const hasEndMarker = hasActualEndMarker(output, nonce, endMarkerRegex);

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
        nonce,
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

      clearActiveRequest(ctx.paths, pane, requestId);

      const result: WaitResult = { requestId, nonce, endMarker, response };
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
    clearActiveRequest(ctx.paths, pane, requestId);
  }
}

// ─────────────────────────────────────────────────────────────
