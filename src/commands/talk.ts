// ─────────────────────────────────────────────────────────────
// talk command - send message to agent(s)
// ─────────────────────────────────────────────────────────────

import type { Context } from '../types.js';
import { ExitCodes } from '../exits.js';
import { colors } from '../ui.js';

export function cmdTalk(ctx: Context, target: string, message: string): void {
  const { ui, config, tmux, flags, exit } = ctx;

  if (target === 'all') {
    const agents = Object.entries(config.paneRegistry);
    if (agents.length === 0) {
      ui.error("No agents configured. Use 'tmux-team add' first.");
      exit(ExitCodes.CONFIG_MISSING);
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

  try {
    // Special handling: Gemini doesn't like exclamation marks
    const msg = target === 'gemini' ? message.replace(/!/g, '') : message;
    tmux.send(pane, msg);

    if (flags.json) {
      ui.json({ target, pane, status: 'sent' });
    } else {
      console.log(`${colors.green('→')} Sent to ${colors.cyan(target)} (${pane})`);
    }
  } catch {
    ui.error(`Failed to send to pane ${pane}. Is tmux running?`);
    exit(ExitCodes.ERROR);
  }
}
