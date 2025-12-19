// ─────────────────────────────────────────────────────────────
// talk command - send message to agent(s)
// ─────────────────────────────────────────────────────────────

import type { Context, PaneEntry } from '../types.js';
import type { WaitResult } from '../types.js';
import { ExitCodes } from '../exits.js';
import { colors } from '../ui.js';
import crypto from 'crypto';
import { cleanupState, clearActiveRequest, setActiveRequest } from '../state.js';
import { resolveActor } from '../pm/permissions.js';

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeRequestId(): string {
  return `req_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function makeNonce(): string {
  return crypto.randomBytes(2).toString('hex');
}

function renderWaitLine(agent: string, elapsedSeconds: number): string {
  const s = Math.max(0, Math.floor(elapsedSeconds));
  return `⏳ Waiting for ${agent}... (${s}s)`;
}

// ─────────────────────────────────────────────────────────────
// Types for broadcast wait mode
// ─────────────────────────────────────────────────────────────

interface AgentWaitState {
  agent: string;
  pane: string;
  requestId: string;
  nonce: string;
  marker: string;
  baseline: string;
  status: 'pending' | 'completed' | 'timeout' | 'error';
  response?: string;
  error?: string;
  elapsedMs?: number;
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
 */
function buildMessage(message: string, agentName: string, ctx: Context): string {
  const { config, flags } = ctx;

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
  const marker = `{tmux-team-end:${nonce}}`;

  // Build message with preamble, then append nonce instruction
  const messageWithPreamble = buildMessage(message, target, ctx);
  const fullMessage = `${messageWithPreamble}\n\n[IMPORTANT: When your response is complete, print exactly: ${marker}]`;

  // Best-effort cleanup and soft-lock warning
  const state = cleanupState(ctx.paths, 60 * 60); // 1 hour TTL
  const existing = state.requests[target];
  if (existing && !flags.json && !flags.force) {
    ui.warn(
      `Another recent wait request exists for '${target}' (id: ${existing.id}). Results may interleave.`
    );
  }

  let baseline = '';
  try {
    baseline = tmux.capture(pane, captureLines);
  } catch {
    ui.error(`Failed to capture pane ${pane}. Is tmux running?`);
    exit(ExitCodes.ERROR);
  }

  setActiveRequest(ctx.paths, target, { id: requestId, nonce, pane, startedAtMs: Date.now() });

  const startedAt = Date.now();
  let lastNonTtyLogAt = 0;
  const isTTY = process.stdout.isTTY && !flags.json;

  const onSigint = (): void => {
    clearActiveRequest(ctx.paths, target, requestId);
    if (!flags.json) process.stdout.write('\n');
    ui.error('Interrupted.');
    exit(ExitCodes.ERROR);
  };

  process.once('SIGINT', onSigint);

  try {
    const msg = target === 'gemini' ? fullMessage.replace(/!/g, '') : fullMessage;
    tmux.send(pane, msg);

    while (true) {
      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      if (elapsedSeconds >= timeoutSeconds) {
        clearActiveRequest(ctx.paths, target, requestId);
        if (flags.json) {
          // Single JSON output with error field (don't call ui.error separately)
          ui.json({
            target,
            pane,
            status: 'timeout',
            error: `Timed out waiting for ${target} after ${Math.floor(timeoutSeconds)}s`,
            requestId,
            nonce,
            marker,
          });
          exit(ExitCodes.TIMEOUT);
        }
        if (isTTY) {
          process.stdout.write('\r' + ' '.repeat(80) + '\r');
        }
        ui.error(`Timed out waiting for ${target} after ${Math.floor(timeoutSeconds)}s.`);
        exit(ExitCodes.TIMEOUT);
      }

      if (!flags.json) {
        if (isTTY) {
          process.stdout.write('\r' + renderWaitLine(target, elapsedSeconds));
        } else {
          const now = Date.now();
          if (now - lastNonTtyLogAt >= 5000) {
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

      const markerIndex = output.indexOf(marker);
      if (markerIndex === -1) continue;

      let startIndex = 0;
      const baselineIndex = baseline ? output.lastIndexOf(baseline) : -1;
      if (baselineIndex !== -1) {
        startIndex = baselineIndex + baseline.length;
      }

      const response = output.slice(startIndex, markerIndex).trim();

      if (!flags.json && isTTY) {
        process.stdout.write('\r' + ' '.repeat(80) + '\r');
      } else if (!flags.json) {
        // Ensure the next output starts on a new line
        process.stdout.write('\n');
      }

      clearActiveRequest(ctx.paths, target, requestId);

      const result: WaitResult = { requestId, nonce, marker, response };
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

  // Best-effort state cleanup
  cleanupState(paths, 60 * 60);

  // Initialize wait state for each agent with unique nonces
  const agentStates: AgentWaitState[] = [];

  if (!flags.json) {
    console.log(
      `${colors.cyan('→')} Broadcasting to ${targetAgents.length} agent(s) (wait mode)...`
    );
  }

  // Phase 1: Send messages to all agents and capture baselines
  for (const [name, data] of targetAgents) {
    const requestId = makeRequestId();
    const nonce = makeNonce(); // Unique nonce per agent (#19)
    const marker = `{tmux-team-end:${nonce}}`;

    let baseline = '';
    try {
      baseline = tmux.capture(data.pane, captureLines);
    } catch {
      agentStates.push({
        agent: name,
        pane: data.pane,
        requestId,
        nonce,
        marker,
        baseline: '',
        status: 'error',
        error: `Failed to capture pane ${data.pane}`,
      });
      if (!flags.json) {
        ui.warn(`Failed to capture ${name} (${data.pane})`);
      }
      continue;
    }

    // Build and send message
    const messageWithPreamble = buildMessage(message, name, ctx);
    const fullMessage = `${messageWithPreamble}\n\n[IMPORTANT: When your response is complete, print exactly: ${marker}]`;
    const msg = name === 'gemini' ? fullMessage.replace(/!/g, '') : fullMessage;

    try {
      tmux.send(data.pane, msg);
      setActiveRequest(paths, name, {
        id: requestId,
        nonce,
        pane: data.pane,
        startedAtMs: Date.now(),
      });
      agentStates.push({
        agent: name,
        pane: data.pane,
        requestId,
        nonce,
        marker,
        baseline,
        status: 'pending',
      });
      if (!flags.json) {
        console.log(`  ${colors.green('→')} Sent to ${colors.cyan(name)} (${data.pane})`);
      }
    } catch {
      agentStates.push({
        agent: name,
        pane: data.pane,
        requestId,
        nonce,
        marker,
        baseline,
        status: 'error',
        error: `Failed to send to pane ${data.pane}`,
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

  const startedAt = Date.now();
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
      const elapsedSeconds = (Date.now() - startedAt) / 1000;

      // Check timeout for each pending agent (#17)
      for (const state of pendingAgents()) {
        if (elapsedSeconds >= timeoutSeconds) {
          state.status = 'timeout';
          state.error = `Timed out after ${Math.floor(timeoutSeconds)}s`;
          state.elapsedMs = Math.floor(elapsedSeconds * 1000);
          clearActiveRequest(paths, state.agent, state.requestId);
          if (!flags.json) {
            console.log(
              `  ${colors.red('✗')} ${colors.cyan(state.agent)} timed out (${Math.floor(elapsedSeconds)}s)`
            );
          }
        }
      }

      // All done?
      if (pendingAgents().length === 0) break;

      // Progress logging (non-TTY)
      if (!flags.json && !isTTY) {
        const now = Date.now();
        if (now - lastLogAt >= 5000) {
          lastLogAt = now;
          const pending = pendingAgents()
            .map((s) => s.agent)
            .join(', ');
          console.error(
            `[tmux-team] Waiting for: ${pending} (${Math.floor(elapsedSeconds)}s elapsed)`
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
          state.elapsedMs = Date.now() - startedAt;
          clearActiveRequest(paths, state.agent, state.requestId);
          if (!flags.json) {
            ui.warn(`Failed to capture ${state.agent}`);
          }
          continue;
        }

        const markerIndex = output.indexOf(state.marker);
        if (markerIndex === -1) continue;

        // Found marker - extract response
        let startIndex = 0;
        const baselineIndex = state.baseline ? output.lastIndexOf(state.baseline) : -1;
        if (baselineIndex !== -1) {
          startIndex = baselineIndex + state.baseline.length;
        }

        state.response = output.slice(startIndex, markerIndex).trim();
        state.status = 'completed';
        state.elapsedMs = Date.now() - startedAt;
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
        marker: s.marker,
        baseline: '', // Don't include baseline in output
        status: s.status,
        response: s.response,
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
    }
  }
}
