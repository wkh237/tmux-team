// ─────────────────────────────────────────────────────────────
// Permission system for PM commands
// ─────────────────────────────────────────────────────────────

import type { ResolvedConfig } from '../types.js';

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
 * Get current actor (agent name or 'human').
 * Reads from TMT_AGENT_NAME or TMUX_TEAM_ACTOR env vars.
 */
export function getCurrentActor(): string {
  return process.env.TMT_AGENT_NAME || process.env.TMUX_TEAM_ACTOR || 'human';
}

/**
 * Check if an action is allowed for the current actor.
 * Returns true if allowed, false if denied.
 */
export function checkPermission(config: ResolvedConfig, check: PermissionCheck): boolean {
  const actor = getCurrentActor();

  // Human is always allowed (no deny patterns for human)
  if (actor === 'human') {
    return true;
  }

  // Get agent config
  const agentConfig = config.agents[actor];
  if (!agentConfig || !agentConfig.deny || agentConfig.deny.length === 0) {
    // No deny patterns = allow all
    return true;
  }

  // Check if any deny pattern matches
  for (const pattern of agentConfig.deny) {
    if (matchesPattern(check, pattern)) {
      return false;
    }
  }

  return true;
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

  // Doc operations
  docRead: (): PermissionCheck => ({ resource: 'doc', action: 'read', fields: [] }),
  docUpdate: (): PermissionCheck => ({ resource: 'doc', action: 'update', fields: [] }),

  // Team operations
  teamCreate: (): PermissionCheck => ({ resource: 'team', action: 'create', fields: [] }),
  teamList: (): PermissionCheck => ({ resource: 'team', action: 'list', fields: [] }),

  // Log operations
  logRead: (): PermissionCheck => ({ resource: 'log', action: 'read', fields: [] }),
};
