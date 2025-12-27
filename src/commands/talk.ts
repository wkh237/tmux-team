// ─────────────────────────────────────────────────────────────
// talk command - send message to agent(s)
// ─────────────────────────────────────────────────────────────

import type { Context, PaneEntry } from '../types.js';
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
import { resolveActor } from '../identity.js';

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
  return `---RESPONSE-END-${nonce}---`;
}

/**
 * Build a regex to match the end marker case-insensitively.
 * This handles agents that might print the marker in different case.
 */
function makeEndMarkerRegex(nonce: string): RegExp {
  return new RegExp(`---response-end-${nonce}---`, 'i');
}

/**
 * Build the end marker instruction WITHOUT embedding the literal marker string.
 * This prevents false-positive detection when the instruction is still visible
 * in scrollback but the agent hasn't responded yet.
 *
 * The instruction describes how to construct the marker verbally, so the literal
 * marker string can ONLY appear if the agent actually prints it.
 */
function makeEndMarkerInstruction(nonce: string): string {
  return `When you finish responding, output a completion marker on its own line: three dashes, RESPONSE-END-${nonce}, three dashes (no spaces).`;
}

function renderWaitLine(agent: string, elapsedSeconds: number): string {
  const s = Math.max(0, Math.floor(elapsedSeconds));
  return `⏳ Waiting for ${agent}... (${s}s)`;
}

/**
 * Extract partial response from output when end marker is not found.
 * Used to capture whatever the agent wrote before timeout.
 *
 * With the new protocol, the instruction doesn't contain the literal marker.
 * We look for the instruction line (contains "RESPONSE-END-<nonce>" without dashes)
 * and extract content after it. Falls back to last N lines if instruction not found.
 */
function extractPartialResponse(
  output: string,
  endMarker: string,
  maxLines: number
): string | null {
  const lines = output.split('\n');

  // Extract nonce from endMarker (format: ---RESPONSE-END-xxxx---)
  // Use case-insensitive match to be flexible with nonce format changes
  const nonceMatch = endMarker.match(/RESPONSE-END-([a-f0-9]+)/i);
  if (!nonceMatch) return null;
  const nonce = nonceMatch[1];

  // Find the instruction line (contains "RESPONSE-END-<nonce>" but not the full marker)
  // Case-insensitive to handle potential format variations
  const instructionLineIndex = lines.findIndex(
    (line) =>
      line.toLowerCase().includes(`response-end-${nonce.toLowerCase()}`) &&
      !line.includes(endMarker)
  );

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

// ─────────────────────────────────────────────────────────────
// Types for broadcast wait mode
// ─────────────────────────────────────────────────────────────

interface AgentWaitState {
  agent: string;
  pane: string;
  requestId: string;
  nonce: string;
  endMarker: string;
  status: 'pending' | 'completed' | 'timeout' | 'error';
  response?: string;
  partialResponse?: string | null;
  error?: string;
  elapsedMs?: number;
  // Per-agent timing
  startedAtMs: number;
  // Debounce tracking (per-agent)
  lastOutput: string;
  lastOutputChangeAt: number;
}

interface BroadcastWaitResult {
  target: 'all';
  mode: 'wait';
  self?: string;
  identityWarning?: string;
  summary: {
    total: number;
    completed: number;
    timeout: number;
    error: number;
    skipped: number;
  };
  results: AgentWaitState[];
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
  const agentConfig = config.agents[agentName];
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

  if (target === 'all') {
    const agents = Object.entries(config.paneRegistry);
    if (agents.length === 0) {
      ui.error("No agents configured. Use 'tmux-team add' first.");
      exit(ExitCodes.CONFIG_MISSING);
    }

    // Determine current agent to skip self
    const { actor: self, warning: identityWarning } = resolveActor(config.paneRegistry);

    // Surface identity warnings (mismatch, unregistered pane, etc.)
    if (identityWarning && !flags.json) {
      ui.warn(identityWarning);
    }

    if (flags.delay && flags.delay > 0) {
      await sleepMs(flags.delay * 1000);
    }

    // Filter out self
    const targetAgents = agents.filter(([name]) => name !== self);
    const skippedSelf = agents.length !== targetAgents.length;

    if (!waitEnabled) {
      // Non-wait mode: fire and forget
      const results: { agent: string; pane: string; status: string }[] = [];

      if (skippedSelf) {
        const selfData = config.paneRegistry[self];
        results.push({ agent: self, pane: selfData?.pane || '', status: 'skipped (self)' });
        if (!flags.json) {
          console.log(`${colors.dim('○')} Skipped ${colors.cyan(self)} (self)`);
        }
      }

      for (const [name, data] of targetAgents) {
        try {
          let msg = buildMessage(message, name, ctx);
          if (name === 'gemini') msg = msg.replace(/!/g, '');
          tmux.send(data.pane, msg);
          results.push({ agent: name, pane: data.pane, status: 'sent' });
          if (!flags.json) {
            console.log(`${colors.green('→')} Sent to ${colors.cyan(name)} (${data.pane})`);
          }
        } catch {
          results.push({ agent: name, pane: data.pane, status: 'failed' });
          if (!flags.json) {
            ui.warn(`Failed to send to ${name}`);
          }
        }
      }

      if (flags.json) {
        ui.json({ target: 'all', self, identityWarning, results });
      }
      return;
    }

    // Wait mode: parallel polling
    await cmdTalkAllWait(ctx, targetAgents, message, self, identityWarning, skippedSelf);
    return;
  }

  // Single agent
  if (!config.paneRegistry[target]) {
    const available = Object.keys(config.paneRegistry).join(', ');
    ui.error(`Agent '${target}' not found. Available: ${available || 'none'}`);
    exit(ExitCodes.PANE_NOT_FOUND);
  }

  const pane = config.paneRegistry[target].pane;

  if (flags.delay && flags.delay > 0) {
    await sleepMs(flags.delay * 1000);
  }

  if (!waitEnabled) {
    try {
      // Build message with preamble, then apply Gemini filter
      let msg = buildMessage(message, target, ctx);
      if (target === 'gemini') msg = msg.replace(/!/g, '');
      tmux.send(pane, msg);

      if (flags.json) {
        ui.json({ target, pane, status: 'sent' });
      } else {
        console.log(`${colors.green('→')} Sent to ${colors.cyan(target)} (${pane})`);
      }
      return;
    } catch {
      ui.error(`Failed to send to pane ${pane}. Is tmux running?`);
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
  const messageWithPreamble = buildMessage(message, target, ctx);
  const fullMessage = `${messageWithPreamble}\n\n${makeEndMarkerInstruction(nonce)}`;

  // Best-effort cleanup and soft-lock warning
  const state = cleanupState(ctx.paths, 60 * 60); // 1 hour TTL
  const existing = state.requests[target];
  if (existing && !flags.json && !flags.force) {
    ui.warn(
      `Another recent wait request exists for '${target}' (id: ${existing.id}). Results may interleave.`
    );
  }

  setActiveRequest(ctx.paths, target, { id: requestId, nonce, pane, startedAtMs: Date.now() });

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
    clearActiveRequest(ctx.paths, target, requestId);
    if (!flags.json) process.stdout.write('\n');
    ui.error('Interrupted.');
    exit(ExitCodes.ERROR);
  };

  process.once('SIGINT', onSigint);

  try {
    const msg = target === 'gemini' ? fullMessage.replace(/!/g, '') : fullMessage;

    if (flags.debug) {
      console.error(`[DEBUG] Starting wait mode for ${target}`);
      console.error(`[DEBUG] End marker: ${endMarker}`);
      console.error(`[DEBUG] Message sent:\n${msg}`);
    }

    tmux.send(pane, msg);

    while (true) {
      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      if (elapsedSeconds >= timeoutSeconds) {
        clearActiveRequest(ctx.paths, target, requestId);

        // Capture partial response on timeout
        const responseLines = flags.lines ?? 100;
        let partialResponse: string | null = null;
        try {
          const output = tmux.capture(pane, captureLines);
          const extracted = extractPartialResponse(output, endMarker, responseLines);
          if (extracted) {
            partialResponse = target === 'gemini' ? cleanGeminiResponse(extracted) : extracted;
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
            status: 'timeout',
            error: `Timed out waiting for ${target} after ${Math.floor(timeoutSeconds)}s`,
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
          console.log(colors.yellow(`─── Partial response from ${target} (${pane}) ───`));
          console.log(partialResponse);
        }
        exit(ExitCodes.TIMEOUT);
      }

      if (!flags.json) {
        if (isTTY) {
          process.stdout.write('\r' + renderWaitLine(target, elapsedSeconds));
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
        clearActiveRequest(ctx.paths, target, requestId);
        ui.error(`Failed to capture pane ${pane}. Is tmux running?`);
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
      const endMarkerRegex = makeEndMarkerRegex(nonce);
      const hasEndMarker = endMarkerRegex.test(output);

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

      // Extract response: get N lines before the end marker
      const responseLines = flags.lines ?? 100;
      const lines = output.split('\n');

      // Find the line with the end marker (last occurrence = agent's marker)
      // Find end marker line (case-insensitive)
      let endMarkerLineIndex = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (endMarkerRegex.test(lines[i])) {
          endMarkerLineIndex = i;
          break;
        }
      }

      if (endMarkerLineIndex === -1) continue;

      // Protocol: instruction describes the marker verbally but doesn't contain the literal string.
      // So any occurrence of the literal marker is definitively from the agent.
      //
      // Try to anchor extraction to the instruction line (cleaner output when visible).
      // Fall back to N lines before marker if instruction scrolled off.
      let startLine: number;
      const instructionLineIndex = lines.findIndex(
        (line) =>
          line.toLowerCase().includes(`response-end-${nonce.toLowerCase()}`) &&
          !endMarkerRegex.test(line)
      );

      if (instructionLineIndex !== -1 && instructionLineIndex < endMarkerLineIndex) {
        // Instruction visible: extract from after instruction to marker
        startLine = instructionLineIndex + 1;
      } else {
        // Instruction scrolled off: extract N lines before marker
        startLine = Math.max(0, endMarkerLineIndex - responseLines);
      }

      let response = lines.slice(startLine, endMarkerLineIndex).join('\n').trim();
      // Clean Gemini CLI UI artifacts
      if (target === 'gemini') {
        response = cleanGeminiResponse(response);
      }

      if (!flags.json && isTTY) {
        process.stdout.write('\r' + ' '.repeat(80) + '\r');
      } else if (!flags.json) {
        // Ensure the next output starts on a new line
        process.stdout.write('\n');
      }

      clearActiveRequest(ctx.paths, target, requestId);

      const result: WaitResult = { requestId, nonce, endMarker, response };
      if (flags.json) {
        ui.json({ target, pane, status: 'completed', ...result });
      } else {
        console.log(colors.cyan(`─── Response from ${target} (${pane}) ───`));
        console.log(response);
      }
      return;
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    clearActiveRequest(ctx.paths, target, requestId);
  }
}

// ─────────────────────────────────────────────────────────────
// Broadcast wait mode: parallel polling for all agents
// ─────────────────────────────────────────────────────────────

async function cmdTalkAllWait(
  ctx: Context,
  targetAgents: [string, PaneEntry][],
  message: string,
  self: string,
  identityWarning: string | undefined,
  skippedSelf: boolean
): Promise<void> {
  const { ui, config, tmux, flags, exit, paths } = ctx;
  const timeoutSeconds = flags.timeout ?? config.defaults.timeout;
  const pollIntervalSeconds = Math.max(0.1, config.defaults.pollInterval);
  const captureLines = config.defaults.captureLines;

  // Debounce detection constants (same as single-agent mode)
  // Adaptive: for very short timeouts (testing), reduce debounce thresholds
  const timeoutMs = timeoutSeconds * 1000;
  const MIN_WAIT_MS = Math.min(3000, timeoutMs * 0.3); // Wait at least 3s or 30% of timeout
  const IDLE_THRESHOLD_MS = Math.min(3000, timeoutMs * 0.3); // Stable for 3s or 30% of timeout

  // Best-effort state cleanup
  cleanupState(paths, 60 * 60);

  // Initialize wait state for each agent with unique nonces
  const agentStates: AgentWaitState[] = [];

  if (!flags.json) {
    console.log(
      `${colors.cyan('→')} Broadcasting to ${targetAgents.length} agent(s) (wait mode)...`
    );
  }

  // Phase 1: Send messages to all agents with end markers
  for (const [name, data] of targetAgents) {
    const requestId = makeRequestId();
    const nonce = makeNonce(); // Unique nonce per agent (#19)
    const endMarker = makeEndMarker(nonce);

    // Build and send message with end marker instruction
    // Note: instruction doesn't contain literal marker to prevent false-positive detection
    const messageWithPreamble = buildMessage(message, name, ctx);
    const fullMessage = `${messageWithPreamble}\n\n${makeEndMarkerInstruction(nonce)}`;
    const msg = name === 'gemini' ? fullMessage.replace(/!/g, '') : fullMessage;

    try {
      const now = Date.now();
      tmux.send(data.pane, msg);
      setActiveRequest(paths, name, {
        id: requestId,
        nonce,
        pane: data.pane,
        startedAtMs: now,
      });
      agentStates.push({
        agent: name,
        pane: data.pane,
        requestId,
        nonce,
        endMarker,
        status: 'pending',
        // Per-agent timing
        startedAtMs: now,
        // Initialize debounce tracking
        lastOutput: '',
        lastOutputChangeAt: now,
      });
      if (!flags.json) {
        console.log(`  ${colors.green('→')} Sent to ${colors.cyan(name)} (${data.pane})`);
      }
    } catch {
      const now = Date.now();
      agentStates.push({
        agent: name,
        pane: data.pane,
        requestId,
        nonce,
        endMarker,
        status: 'error',
        error: `Failed to send to pane ${data.pane}`,
        startedAtMs: now,
        lastOutput: '',
        lastOutputChangeAt: now,
      });
      if (!flags.json) {
        ui.warn(`Failed to send to ${name}`);
      }
    }
  }

  // Track pending agents
  const pendingAgents = () => agentStates.filter((s) => s.status === 'pending');

  if (pendingAgents().length === 0) {
    // All failed to send, output results and exit with error
    outputBroadcastResults(ctx, agentStates, self, identityWarning, skippedSelf);
    exit(ExitCodes.ERROR);
    return;
  }

  let lastLogAt = 0;
  const isTTY = process.stdout.isTTY && !flags.json;

  // SIGINT handler: cleanup ALL active requests (#18)
  const onSigint = (): void => {
    for (const state of agentStates) {
      clearActiveRequest(paths, state.agent, state.requestId);
    }
    if (!flags.json) {
      process.stdout.write('\n');
      ui.error('Interrupted.');
    }
    // Output partial results
    outputBroadcastResults(ctx, agentStates, self, identityWarning, skippedSelf);
    exit(ExitCodes.ERROR);
  };

  process.once('SIGINT', onSigint);

  try {
    // Phase 2: Poll all agents in parallel until all complete or timeout
    while (pendingAgents().length > 0) {
      // Check timeout for each pending agent using per-agent timing
      for (const state of pendingAgents()) {
        const agentElapsedMs = Date.now() - state.startedAtMs;
        const agentElapsedSeconds = agentElapsedMs / 1000;

        if (agentElapsedSeconds >= timeoutSeconds) {
          state.status = 'timeout';
          state.error = `Timed out after ${Math.floor(agentElapsedSeconds)}s`;
          state.elapsedMs = agentElapsedMs;

          // Capture partial response on timeout
          const responseLines = flags.lines ?? 100;
          try {
            const output = tmux.capture(state.pane, captureLines);
            const extracted = extractPartialResponse(output, state.endMarker, responseLines);
            if (extracted) {
              state.partialResponse =
                state.agent === 'gemini' ? cleanGeminiResponse(extracted) : extracted;
            }
          } catch {
            // Ignore capture errors on timeout
          }

          clearActiveRequest(paths, state.agent, state.requestId);
          if (!flags.json) {
            console.log(
              `  ${colors.red('✗')} ${colors.cyan(state.agent)} timed out (${Math.floor(agentElapsedSeconds)}s)`
            );
          }
        }
      }

      // All done?
      if (pendingAgents().length === 0) break;

      // Progress logging (non-TTY, only with --verbose or --debug)
      if (!flags.json && !isTTY && (flags.verbose || flags.debug)) {
        const now = Date.now();
        if (now - lastLogAt >= 30000) {
          lastLogAt = now;
          const pending = pendingAgents()
            .map((s) => s.agent)
            .join(', ');
          // Use the oldest pending agent's elapsed time for logging
          const maxElapsed = Math.max(...pendingAgents().map((s) => now - s.startedAtMs));
          console.error(
            `[tmux-team] Waiting for: ${pending} (${Math.floor(maxElapsed / 1000)}s elapsed)`
          );
        }
      }

      await sleepMs(pollIntervalSeconds * 1000);

      // Poll each pending agent
      for (const state of pendingAgents()) {
        let output = '';
        try {
          output = tmux.capture(state.pane, captureLines);
        } catch {
          state.status = 'error';
          state.error = `Failed to capture pane ${state.pane}`;
          state.elapsedMs = Date.now() - state.startedAtMs;
          clearActiveRequest(paths, state.agent, state.requestId);
          if (!flags.json) {
            ui.warn(`Failed to capture ${state.agent}`);
          }
          continue;
        }

        // Track output changes for debounce detection (per-agent)
        if (output !== state.lastOutput) {
          state.lastOutput = output;
          state.lastOutputChangeAt = Date.now();
        }

        // Use per-agent timing for accurate elapsed calculation
        const now = Date.now();
        const elapsedMs = now - state.startedAtMs;
        const idleMs = now - state.lastOutputChangeAt;

        // Find end marker (case-insensitive to handle agent variations)
        const endMarkerRegex = makeEndMarkerRegex(state.nonce);
        const hasEndMarker = endMarkerRegex.test(output);

        // Completion conditions (same as single-agent mode):
        // 1. Must wait at least MIN_WAIT_MS
        // 2. Must have end marker in output
        // 3. Output must be stable for IDLE_THRESHOLD_MS (debounce)
        if (elapsedMs < MIN_WAIT_MS || !hasEndMarker || idleMs < IDLE_THRESHOLD_MS) {
          continue;
        }

        // Extract response: get N lines before the agent's end marker
        const responseLines = flags.lines ?? 100;
        const lines = output.split('\n');

        // Find end marker line (case-insensitive)
        let endMarkerLineIndex = -1;
        for (let i = lines.length - 1; i >= 0; i--) {
          if (endMarkerRegex.test(lines[i])) {
            endMarkerLineIndex = i;
            break;
          }
        }

        if (endMarkerLineIndex === -1) continue;

        // Protocol: instruction describes the marker verbally but doesn't contain the literal string.
        // So any occurrence of the literal marker is definitively from the agent.
        //
        // Try to anchor extraction to the instruction line (cleaner output when visible).
        // Fall back to N lines before marker if instruction scrolled off.
        let startLine: number;
        const instructionLineIndex = lines.findIndex(
          (line) =>
            line.toLowerCase().includes(`response-end-${state.nonce.toLowerCase()}`) &&
            !endMarkerRegex.test(line)
        );

        if (instructionLineIndex !== -1 && instructionLineIndex < endMarkerLineIndex) {
          // Instruction visible: extract from after instruction to marker
          startLine = instructionLineIndex + 1;
        } else {
          // Instruction scrolled off: extract N lines before marker
          startLine = Math.max(0, endMarkerLineIndex - responseLines);
        }

        let response = lines.slice(startLine, endMarkerLineIndex).join('\n').trim();
        // Clean Gemini CLI UI artifacts
        if (state.agent === 'gemini') {
          response = cleanGeminiResponse(response);
        }
        state.response = response;
        state.status = 'completed';
        state.elapsedMs = elapsedMs;
        clearActiveRequest(paths, state.agent, state.requestId);

        if (!flags.json) {
          console.log(
            `  ${colors.green('✓')} ${colors.cyan(state.agent)} completed (${Math.floor(state.elapsedMs / 1000)}s)`
          );
        }
      }
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    // Cleanup any remaining active requests
    for (const state of agentStates) {
      clearActiveRequest(paths, state.agent, state.requestId);
    }
  }

  // Output results
  outputBroadcastResults(ctx, agentStates, self, identityWarning, skippedSelf);

  // Exit with appropriate code
  const hasTimeout = agentStates.some((s) => s.status === 'timeout');
  const hasError = agentStates.some((s) => s.status === 'error');
  if (hasTimeout) {
    exit(ExitCodes.TIMEOUT);
  } else if (hasError) {
    exit(ExitCodes.ERROR);
  }
}

function outputBroadcastResults(
  ctx: Context,
  agentStates: AgentWaitState[],
  self: string,
  identityWarning: string | undefined,
  skippedSelf: boolean
): void {
  const { ui, flags } = ctx;

  const summary = {
    total: agentStates.length + (skippedSelf ? 1 : 0),
    completed: agentStates.filter((s) => s.status === 'completed').length,
    timeout: agentStates.filter((s) => s.status === 'timeout').length,
    error: agentStates.filter((s) => s.status === 'error').length,
    skipped: skippedSelf ? 1 : 0,
  };

  if (flags.json) {
    const result: BroadcastWaitResult = {
      target: 'all',
      mode: 'wait',
      self,
      identityWarning,
      summary,
      results: agentStates.map((s) => ({
        agent: s.agent,
        pane: s.pane,
        requestId: s.requestId,
        nonce: s.nonce,
        endMarker: s.endMarker,
        status: s.status,
        response: s.response,
        partialResponse: s.partialResponse,
        error: s.error,
        elapsedMs: s.elapsedMs,
      })),
    };
    ui.json(result);
    return;
  }

  // Human-readable output
  console.log();
  console.log(
    `${colors.cyan('Summary:')} ${summary.completed} completed, ${summary.timeout} timeout, ${summary.error} error, ${summary.skipped} skipped`
  );
  console.log();

  // Print responses
  for (const state of agentStates) {
    if (state.status === 'completed' && state.response) {
      console.log(colors.cyan(`─── Response from ${state.agent} (${state.pane}) ───`));
      console.log(state.response);
      console.log();
    } else if (state.status === 'timeout' && state.partialResponse) {
      console.log(colors.yellow(`─── Partial response from ${state.agent} (${state.pane}) ───`));
      console.log(state.partialResponse);
      console.log();
    }
  }
}
