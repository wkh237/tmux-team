// ─────────────────────────────────────────────────────────────
// Registry helpers for workspace/team scoped agent metadata
// ─────────────────────────────────────────────────────────────

import type { AgentRegistration, Context, PaneEntry, RegistryScope } from './types.js';

export function getRegistryScope(ctx: Context): RegistryScope {
  if (ctx.registryScope) return ctx.registryScope;
  if (ctx.flags.team) {
    return { type: 'team', teamName: ctx.flags.team };
  }
  return {
    type: 'workspace',
    workspaceRoot: ctx.paths.workspaceRoot ?? process.cwd(),
  };
}

export function scopeLabel(scope: RegistryScope): string {
  return scope.type === 'team' ? `team "${scope.teamName}"` : `workspace ${scope.workspaceRoot}`;
}

export function registrationFromEntry(name: string, entry?: PaneEntry): AgentRegistration {
  return {
    name,
    ...(entry?.remark !== undefined && { remark: entry.remark }),
    ...(entry?.preamble !== undefined && { preamble: entry.preamble }),
    ...(entry?.deny !== undefined && { deny: entry.deny }),
  };
}
