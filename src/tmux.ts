// ─────────────────────────────────────────────────────────────
// Pure tmux wrapper - send-keys, capture-pane, pane detection
// ─────────────────────────────────────────────────────────────

import { execSync } from 'child_process';
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
