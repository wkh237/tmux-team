// ─────────────────────────────────────────────────────────────
// this command - register current pane as an agent
// ─────────────────────────────────────────────────────────────

import type { Context } from '../types.js';
import { ExitCodes } from '../exits.js';
import { cmdAdd } from './add.js';

export function cmdThis(ctx: Context, name: string, remark?: string): void {
  const { ui, tmux, exit } = ctx;

  const currentPaneId = tmux.getCurrentPaneId();
  if (!currentPaneId) {
    ui.error('Not running inside tmux.');
    return exit(ExitCodes.ERROR);
  }

  // Reuse existing add logic
  cmdAdd(ctx, name, currentPaneId, remark);
}
