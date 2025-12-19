// ─────────────────────────────────────────────────────────────
// talk command - send message to agent(s)
// ─────────────────────────────────────────────────────────────

import type { Context } from '../types.js';
import type { WaitResult } from '../types.js';
import { ExitCodes } from '../exits.js';
import { colors } from '../ui.js';
import crypto from 'crypto';
import { cleanupState, clearActiveRequest, setActiveRequest } from '../state.js';

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

export async function cmdTalk(ctx: Context, target: string, message: string): Promise<void> {
  const { ui, config, tmux, flags, exit } = ctx;
  const waitEnabled = Boolean(flags.wait) || config.mode === 'wait';

  if (waitEnabled && target === 'all') {
    ui.error("Wait mode is not supported with 'all' yet. Send to one agent at a time.");
    exit(ExitCodes.ERROR);
  }

  if (target === 'all') {
    const agents = Object.entries(config.paneRegistry);
    if (agents.length === 0) {
      ui.error("No agents configured. Use 'tmux-team add' first.");
      exit(ExitCodes.CONFIG_MISSING);
    }

    if (flags.delay && flags.delay > 0) {
      await sleepMs(flags.delay * 1000);
    }

    const results: { agent: string; pane: string; status: string }[] = [];

    for (const [name, data] of agents) {
      try {
        // Special handling: Gemini doesn't like exclamation marks
        const msg = name === 'gemini' ? message.replace(/!/g, '') : message;
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
      ui.json({ target: 'all', results });
    }
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
      const msg = target === 'gemini' ? message.replace(/!/g, '') : message;
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

  const fullMessage = `${message}\n\n[IMPORTANT: When your response is complete, print exactly: ${marker}]`;

  // Best-effort cleanup and soft-lock warning
  const state = cleanupState(ctx.paths, 24 * 60 * 60);
  const existing = state.requests[target];
  if (existing && !flags.json) {
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
          ui.json({
            target,
            pane,
            status: 'timeout',
            requestId,
            nonce,
            marker,
          });
        } else if (isTTY) {
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
            console.error(`[tmux-team] Waiting for ${target} (${Math.floor(elapsedSeconds)}s elapsed)`);
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
