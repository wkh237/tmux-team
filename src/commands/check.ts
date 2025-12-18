// ─────────────────────────────────────────────────────────────
// check command - capture output from agent's pane
// ─────────────────────────────────────────────────────────────

import type { Context } from '../types.js';
import { ExitCodes } from '../exits.js';
import { colors } from '../ui.js';

export function cmdCheck(ctx: Context, target: string, lines?: number): void {
  const { ui, config, tmux, flags, exit } = ctx;

  if (!config.paneRegistry[target]) {
    const available = Object.keys(config.paneRegistry).join(', ');
    ui.error(`Agent '${target}' not found. Available: ${available || 'none'}`);
    exit(ExitCodes.PANE_NOT_FOUND);
  }

  const pane = config.paneRegistry[target].pane;
  const captureLines = lines ?? config.defaults.captureLines;

  try {
    const output = tmux.capture(pane, captureLines);

    if (flags.json) {
      ui.json({ target, pane, lines: captureLines, output });
    } else {
      console.log(colors.cyan(`─── Output from ${target} (${pane}) ───`));
      console.log(output);
    }
  } catch {
    ui.error(`Failed to capture pane ${pane}. Is tmux running?`);
    exit(ExitCodes.ERROR);
  }
}
