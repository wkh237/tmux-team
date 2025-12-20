// ─────────────────────────────────────────────────────────────
// Permission system for PM commands
// ─────────────────────────────────────────────────────────────

import { execSync } from 'child_process';
import type { ResolvedConfig, PaneEntry } from '../types.js';

/**
 * Permission expression format:
 * pm:<resource>:<action>(<field1>,<field2>,...)
 *
 * Examples:
 * - pm:task:list
 * - pm:task:update(status)
 * - pm:task:update(assignee,status)
 * - pm:task:update(*) - wildcard, any field
 * - pm:task:update - no fields, entire action
 */

export interface PermissionCheck {
  resource: string; // task, milestone, team, doc, log
  action: string; // list, show, create, update, read
  fields: string[]; // sorted alphabetically
}

/**
 * Build permission path from command context.
 */
export function buildPermissionPath(check: PermissionCheck): string {
  const base = `pm:${check.resource}:${check.action}`;
  if (check.fields.length === 0) {
    return base;
  }
  // Sort fields alphabetically for canonical form
  const sortedFields = [...check.fields].sort();
  return `${base}(${sortedFields.join(',')})`;
}

/**
 * Parse a deny pattern into its components.
 */
function parsePattern(pattern: string): {
  resource: string;
  action: string;
  fields: string[] | '*' | null;
} {
  // Pattern format: pm:resource:action or pm:resource:action(fields) or pm:resource:action(*)
  const match = pattern.match(/^pm:(\w+):(\w+)(?:\(([^)]*)\))?$/);
  if (!match) {
    return { resource: '', action: '', fields: null };
  }

  const [, resource, action, fieldsStr] = match;

  if (fieldsStr === undefined) {
    // No parentheses - blocks entire action
    return { resource, action, fields: null };
  }

  if (fieldsStr === '*') {
    // Wildcard - blocks any field
    return { resource, action, fields: '*' };
  }

  // Specific fields
  const fields = fieldsStr
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean);
  return { resource, action, fields };
}

/**
 * Check if a permission path matches a deny pattern.
 */
function matchesPattern(path: PermissionCheck, pattern: string): boolean {
  const parsed = parsePattern(pattern);

  // Resource and action must match
  if (parsed.resource !== path.resource || parsed.action !== path.action) {
    return false;
  }

  // No fields in pattern = block entire action
  if (parsed.fields === null) {
    return true;
  }

  // Wildcard = block if path has any fields
  if (parsed.fields === '*') {
    return path.fields.length > 0;
  }

  // Specific fields = block if path uses ANY of the denied fields
  return parsed.fields.some((f) => path.fields.includes(f));
}

/**
 * Get current tmux pane in "window.pane" format.
 * Returns null if not running in tmux.
 */
function getCurrentPane(): string | null {
  // Check if we're in tmux
  if (!process.env.TMUX) {
    return null;
  }

  // TMUX_PANE contains the pane ID (e.g., %130) for the shell that's running.
  // We must use -t "$TMUX_PANE" to get the correct pane, otherwise tmux returns
  // the currently focused pane which may be different when commands are sent
  // via send-keys from another pane.
  // See: https://github.com/tmux/tmux/issues/4638
  const tmuxPane = process.env.TMUX_PANE;
  if (!tmuxPane) {
    return null;
  }

  try {
    const result = execSync(
      `tmux display-message -p -t "${tmuxPane}" '#{window_index}.#{pane_index}'`,
      {
        encoding: 'utf-8',
        timeout: 1000,
      }
    ).trim();
    return result || null;
  } catch {
    return null;
  }
}

/**
 * Look up agent name by pane ID in the registry.
 */
function findAgentByPane(paneRegistry: Record<string, PaneEntry>, paneId: string): string | null {
  for (const [agentName, entry] of Object.entries(paneRegistry)) {
    if (entry.pane === paneId) {
      return agentName;
    }
  }
  return null;
}

export interface ActorResolution {
  actor: string;
  source: 'pane' | 'env' | 'default';
  warning?: string;
}

/**
 * Resolve current actor using pane registry as primary source.
 *
 * Priority:
 * 1. Look up current tmux pane in pane registry → agent name
 * 2. If not in registry → 'human' (full access)
 *
 * Warnings:
 * - If TMT_AGENT_NAME is set but conflicts with pane registry → warn about spoofing
 * - If TMT_AGENT_NAME is set but pane not in registry → warn about unregistered pane
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
    // Pane is registered to an agent
    if (envActor && envActor !== paneAgent) {
      // Env var conflicts with pane registry - warn about potential spoofing
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
    // Agent claims identity but pane not registered - use env identity with warning
    // Security: Still apply agent's deny patterns to prevent bypass via unregistered pane
    return {
      actor: envActor,
      source: 'env',
      warning: `⚠️  Unregistered pane: pane ${currentPane} is not in registry. Using TMT_AGENT_NAME="${envActor}".`,
    };
  }

  // Not registered, no env var - human
  return { actor: 'human', source: 'default' };
}

/**
 * Get current actor (agent name or 'human').
 * Legacy function for backward compatibility.
 * Reads from TMT_AGENT_NAME or TMUX_TEAM_ACTOR env vars.
 */
export function getCurrentActor(): string {
  return process.env.TMT_AGENT_NAME || process.env.TMUX_TEAM_ACTOR || 'human';
}

export interface PermissionResult {
  allowed: boolean;
  actor: string;
  source: 'pane' | 'env' | 'default';
  warning?: string;
}

/**
 * Check if an action is allowed for the current actor.
 * Uses pane-based identity resolution with warnings for conflicts.
 */
export function checkPermission(config: ResolvedConfig, check: PermissionCheck): PermissionResult {
  const resolution = resolveActor(config.paneRegistry);
  const { actor, source, warning } = resolution;

  // Human is always allowed (no deny patterns for human)
  if (actor === 'human') {
    return { allowed: true, actor, source, warning };
  }

  // Get agent config
  const agentConfig = config.agents[actor];
  if (!agentConfig || !agentConfig.deny || agentConfig.deny.length === 0) {
    // No deny patterns = allow all
    return { allowed: true, actor, source, warning };
  }

  // Check if any deny pattern matches
  for (const pattern of agentConfig.deny) {
    if (matchesPattern(check, pattern)) {
      return { allowed: false, actor, source, warning };
    }
  }

  return { allowed: true, actor, source, warning };
}

/**
 * Simple permission check (legacy, for tests).
 * Returns true if allowed, false if denied.
 */
export function checkPermissionSimple(config: ResolvedConfig, check: PermissionCheck): boolean {
  return checkPermission(config, check).allowed;
}

/**
 * Build permission check for common PM operations.
 */
export const PermissionChecks = {
  // Task operations
  taskList: (): PermissionCheck => ({ resource: 'task', action: 'list', fields: [] }),
  taskShow: (): PermissionCheck => ({ resource: 'task', action: 'show', fields: [] }),
  taskCreate: (): PermissionCheck => ({ resource: 'task', action: 'create', fields: [] }),
  taskUpdate: (fields: string[]): PermissionCheck => ({
    resource: 'task',
    action: 'update',
    fields,
  }),
  taskDelete: (): PermissionCheck => ({ resource: 'task', action: 'delete', fields: [] }),

  // Milestone operations
  milestoneList: (): PermissionCheck => ({ resource: 'milestone', action: 'list', fields: [] }),
  milestoneCreate: (): PermissionCheck => ({ resource: 'milestone', action: 'create', fields: [] }),
  milestoneUpdate: (fields: string[]): PermissionCheck => ({
    resource: 'milestone',
    action: 'update',
    fields,
  }),
  milestoneDelete: (): PermissionCheck => ({ resource: 'milestone', action: 'delete', fields: [] }),

  // Doc operations
  docRead: (): PermissionCheck => ({ resource: 'doc', action: 'read', fields: [] }),
  docUpdate: (): PermissionCheck => ({ resource: 'doc', action: 'update', fields: [] }),

  // Team operations
  teamCreate: (): PermissionCheck => ({ resource: 'team', action: 'create', fields: [] }),
  teamList: (): PermissionCheck => ({ resource: 'team', action: 'list', fields: [] }),

  // Log operations
  logRead: (): PermissionCheck => ({ resource: 'log', action: 'read', fields: [] }),
};
