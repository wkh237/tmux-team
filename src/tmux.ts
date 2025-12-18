// ─────────────────────────────────────────────────────────────
// Pure tmux wrapper - send-keys, capture-pane
// ─────────────────────────────────────────────────────────────

import { execSync } from 'child_process';
import type { Tmux } from './types.js';

export function createTmux(): Tmux {
  return {
    send(paneId: string, message: string): void {
      execSync(`tmux send-keys -t "${paneId}" ${JSON.stringify(message)}`, {
        stdio: 'pipe',
      });
      execSync(`tmux send-keys -t "${paneId}" Enter`, {
        stdio: 'pipe',
      });
    },

    capture(paneId: string, lines: number): string {
      const output = execSync(`tmux capture-pane -t "${paneId}" -p -S -${lines}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return output;
    },
  };
}
