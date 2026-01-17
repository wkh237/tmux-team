// ─────────────────────────────────────────────────────────────
// Pure tmux wrapper - buffer paste, capture-pane, pane detection
// ─────────────────────────────────────────────────────────────

import { execSync } from 'child_process';
import crypto from 'crypto';
import type { Tmux, PaneInfo } from './types.js';

// Known agent patterns for auto-detection
const KNOWN_AGENTS: Record<string, string[]> = {
  claude: ['claude', 'claude-code'],
  codex: ['codex'],
  gemini: ['gemini'],
  aider: ['aider'],
  cursor: ['cursor'],
};

function detectAgentName(command: string): string | null {
  const lowerCommand = command.toLowerCase();
  for (const [agentName, patterns] of Object.entries(KNOWN_AGENTS)) {
    for (const pattern of patterns) {
      if (lowerCommand.includes(pattern)) {
        return agentName;
      }
    }
  }
  return null;
}

export function createTmux(): Tmux {
  function sleepMs(ms: number): void {
    if (ms <= 0) return;
    const buffer = new SharedArrayBuffer(4);
    const view = new Int32Array(buffer);
    Atomics.wait(view, 0, 0, ms);
  }

  function ensureTrailingNewline(message: string): string {
    return message.endsWith('\n') ? message : `${message}\n`;
  }

  function escapeExclamation(message: string): string {
    // Replace "!" with fullwidth "！" (U+FF01) to avoid shell history expansion
    return message.replace(/!/g, '\uff01');
  }

  function makeBufferName(): string {
    const nonce = crypto.randomBytes(4).toString('hex');
    return `tmt-${process.pid}-${Date.now()}-${nonce}`;
  }

  return {
    send(paneId: string, message: string, options?: { enterDelayMs?: number }): void {
      const enterDelayMs = Math.max(0, options?.enterDelayMs ?? 500);
      const bufferName = makeBufferName();
      const escaped = escapeExclamation(message);
      const payload = ensureTrailingNewline(escaped);

      try {
        execSync(`tmux set-buffer -b "${bufferName}" -- ${JSON.stringify(payload)}`, {
          stdio: 'pipe',
        });
        execSync(`tmux paste-buffer -b "${bufferName}" -d -t "${paneId}" -p`, {
          stdio: 'pipe',
        });
        sleepMs(enterDelayMs);
        execSync(`tmux send-keys -t "${paneId}" Enter`, {
          stdio: 'pipe',
        });
      } catch {
        // Fallback to legacy send-keys if buffer/paste fails
        execSync(`tmux send-keys -t "${paneId}" ${JSON.stringify(message)}`, {
          stdio: 'pipe',
        });
        execSync(`tmux send-keys -t "${paneId}" Enter`, {
          stdio: 'pipe',
        });
      }
    },

    capture(paneId: string, lines: number): string {
      const output = execSync(`tmux capture-pane -t "${paneId}" -p -S -${lines}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return output;
    },

    listPanes(): PaneInfo[] {
      try {
        // Get all panes with their IDs and current commands
        const output = execSync('tmux list-panes -a -F "#{pane_id}\t#{pane_current_command}"', {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        return output
          .trim()
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => {
            const [id, command] = line.split('\t');
            return {
              id: id || '',
              command: command || '',
              suggestedName: detectAgentName(command || ''),
            };
          });
      } catch {
        return [];
      }
    },

    getCurrentPaneId(): string | null {
      // First check environment variable
      if (process.env.TMUX_PANE) {
        return process.env.TMUX_PANE;
      }

      // Fall back to tmux command
      try {
        const output = execSync('tmux display-message -p "#{pane_id}"', {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return output.trim() || null;
      } catch {
        return null;
      }
    },
  };
}
