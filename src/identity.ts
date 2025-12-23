// ─────────────────────────────────────────────────────────────
// Identity resolution - determine current agent from tmux pane
// ─────────────────────────────────────────────────────────────

import { execSync } from 'child_process';
import type { PaneEntry } from './types.js';

export interface ActorResolution {
  actor: string;
  source: 'pane' | 'env' | 'default';
  warning?: string;
}

/**
 * Get current tmux pane ID (e.g., "1.0").
 */
function getCurrentPane(): string | null {
  if (!process.env.TMUX) {
    return null;
  }

  const tmuxPane = process.env.TMUX_PANE;
  if (!tmuxPane) {
    return null;
  }

  try {
    const result = execSync(
      `tmux display-message -p -t "${tmuxPane}" '#{window_index}.#{pane_index}'`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return result.trim();
  } catch {
    return null;
  }
}

/**
 * Find agent name by pane ID.
 */
function findAgentByPane(paneRegistry: Record<string, PaneEntry>, paneId: string): string | null {
  for (const [agentName, entry] of Object.entries(paneRegistry)) {
    if (entry.pane === paneId) {
      return agentName;
    }
  }
  return null;
}

/**
 * Resolve current actor using pane registry as primary source.
 */
export function resolveActor(paneRegistry: Record<string, PaneEntry>): ActorResolution {
  const envActor = process.env.TMT_AGENT_NAME || process.env.TMUX_TEAM_ACTOR;
  const currentPane = getCurrentPane();

  // Not in tmux - use env var or default to human
  if (!currentPane) {
    if (envActor) {
      return { actor: envActor, source: 'env' };
    }
    return { actor: 'human', source: 'default' };
  }

  // In tmux - look up pane in registry
  const paneAgent = findAgentByPane(paneRegistry, currentPane);

  if (paneAgent) {
    if (envActor && envActor !== paneAgent) {
      return {
        actor: paneAgent,
        source: 'pane',
        warning: `⚠️  Identity mismatch: TMT_AGENT_NAME="${envActor}" but pane ${currentPane} is registered to "${paneAgent}". Using pane identity.`,
      };
    }
    return { actor: paneAgent, source: 'pane' };
  }

  // Pane not in registry
  if (envActor) {
    return {
      actor: envActor,
      source: 'env',
      warning: `⚠️  Unregistered pane: pane ${currentPane} is not in registry. Using TMT_AGENT_NAME="${envActor}".`,
    };
  }

  return { actor: 'human', source: 'default' };
}
