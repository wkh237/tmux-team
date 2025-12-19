// ─────────────────────────────────────────────────────────────
// Permission System Tests
// ─────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildPermissionPath,
  checkPermission,
  getCurrentActor,
  PermissionChecks,
} from './permissions.js';
import type { ResolvedConfig } from '../types.js';

function createMockConfig(agents: Record<string, { deny?: string[] }>): ResolvedConfig {
  return {
    mode: 'polling',
    preambleMode: 'always',
    defaults: { timeout: 60, pollInterval: 1, captureLines: 100 },
    agents,
    paneRegistry: {},
  };
}

describe('buildPermissionPath', () => {
  it('builds path without fields', () => {
    expect(buildPermissionPath({ resource: 'task', action: 'list', fields: [] })).toBe(
      'pm:task:list'
    );
  });

  it('builds path with single field', () => {
    expect(buildPermissionPath({ resource: 'task', action: 'update', fields: ['status'] })).toBe(
      'pm:task:update(status)'
    );
  });

  it('builds path with multiple fields sorted alphabetically', () => {
    expect(
      buildPermissionPath({ resource: 'task', action: 'update', fields: ['status', 'assignee'] })
    ).toBe('pm:task:update(assignee,status)');
  });

  it('builds path with fields already sorted', () => {
    expect(
      buildPermissionPath({ resource: 'task', action: 'update', fields: ['assignee', 'status'] })
    ).toBe('pm:task:update(assignee,status)');
  });
});

describe('getCurrentActor', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns TMT_AGENT_NAME if set', () => {
    process.env.TMT_AGENT_NAME = 'codex';
    delete process.env.TMUX_TEAM_ACTOR;
    expect(getCurrentActor()).toBe('codex');
  });

  it('returns TMUX_TEAM_ACTOR if TMT_AGENT_NAME not set', () => {
    delete process.env.TMT_AGENT_NAME;
    process.env.TMUX_TEAM_ACTOR = 'gemini';
    expect(getCurrentActor()).toBe('gemini');
  });

  it('returns human if no env vars set', () => {
    delete process.env.TMT_AGENT_NAME;
    delete process.env.TMUX_TEAM_ACTOR;
    expect(getCurrentActor()).toBe('human');
  });

  it('prefers TMT_AGENT_NAME over TMUX_TEAM_ACTOR', () => {
    process.env.TMT_AGENT_NAME = 'codex';
    process.env.TMUX_TEAM_ACTOR = 'gemini';
    expect(getCurrentActor()).toBe('codex');
  });
});

describe('checkPermission', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('allows everything for human actor', () => {
    delete process.env.TMT_AGENT_NAME;
    delete process.env.TMUX_TEAM_ACTOR;

    const config = createMockConfig({
      codex: { deny: ['pm:task:update(status)'] },
    });

    expect(checkPermission(config, PermissionChecks.taskUpdate(['status']))).toBe(true);
  });

  it('allows when no deny patterns for agent', () => {
    process.env.TMT_AGENT_NAME = 'codex';

    const config = createMockConfig({
      codex: {}, // No deny patterns
    });

    expect(checkPermission(config, PermissionChecks.taskUpdate(['status']))).toBe(true);
  });

  it('allows when agent not in config', () => {
    process.env.TMT_AGENT_NAME = 'unknown-agent';

    const config = createMockConfig({
      codex: { deny: ['pm:task:update(status)'] },
    });

    expect(checkPermission(config, PermissionChecks.taskUpdate(['status']))).toBe(true);
  });

  it('denies when pattern matches exactly', () => {
    process.env.TMT_AGENT_NAME = 'codex';

    const config = createMockConfig({
      codex: { deny: ['pm:task:update(status)'] },
    });

    expect(checkPermission(config, PermissionChecks.taskUpdate(['status']))).toBe(false);
  });

  it('denies when pattern matches any field', () => {
    process.env.TMT_AGENT_NAME = 'codex';

    const config = createMockConfig({
      codex: { deny: ['pm:task:update(status)'] },
    });

    // Using both status and assignee, should still be denied because status is in deny list
    expect(checkPermission(config, PermissionChecks.taskUpdate(['status', 'assignee']))).toBe(
      false
    );
  });

  it('allows when fields do not match', () => {
    process.env.TMT_AGENT_NAME = 'codex';

    const config = createMockConfig({
      codex: { deny: ['pm:task:update(status)'] },
    });

    // Only updating assignee, not status
    expect(checkPermission(config, PermissionChecks.taskUpdate(['assignee']))).toBe(true);
  });

  it('denies entire action when pattern has no fields', () => {
    process.env.TMT_AGENT_NAME = 'codex';

    const config = createMockConfig({
      codex: { deny: ['pm:task:update'] },
    });

    // Any update should be denied
    expect(checkPermission(config, PermissionChecks.taskUpdate(['status']))).toBe(false);
    expect(checkPermission(config, PermissionChecks.taskUpdate(['assignee']))).toBe(false);
    expect(checkPermission(config, PermissionChecks.taskUpdate([]))).toBe(false);
  });

  it('denies when wildcard pattern matches any field', () => {
    process.env.TMT_AGENT_NAME = 'codex';

    const config = createMockConfig({
      codex: { deny: ['pm:task:update(*)'] },
    });

    expect(checkPermission(config, PermissionChecks.taskUpdate(['status']))).toBe(false);
    expect(checkPermission(config, PermissionChecks.taskUpdate(['assignee']))).toBe(false);
  });

  it('allows no-field action when wildcard is used', () => {
    process.env.TMT_AGENT_NAME = 'codex';

    const config = createMockConfig({
      codex: { deny: ['pm:task:update(*)'] },
    });

    // Wildcard only matches when fields are present
    expect(checkPermission(config, PermissionChecks.taskUpdate([]))).toBe(true);
  });

  it('allows different resource', () => {
    process.env.TMT_AGENT_NAME = 'codex';

    const config = createMockConfig({
      codex: { deny: ['pm:task:update(status)'] },
    });

    expect(checkPermission(config, PermissionChecks.milestoneUpdate(['status']))).toBe(true);
  });

  it('allows different action', () => {
    process.env.TMT_AGENT_NAME = 'codex';

    const config = createMockConfig({
      codex: { deny: ['pm:task:update(status)'] },
    });

    expect(checkPermission(config, PermissionChecks.taskCreate())).toBe(true);
    expect(checkPermission(config, PermissionChecks.taskList())).toBe(true);
  });

  it('handles multiple deny patterns', () => {
    process.env.TMT_AGENT_NAME = 'codex';

    const config = createMockConfig({
      codex: {
        deny: ['pm:task:update(status)', 'pm:milestone:update(status)', 'pm:task:delete'],
      },
    });

    expect(checkPermission(config, PermissionChecks.taskUpdate(['status']))).toBe(false);
    expect(checkPermission(config, PermissionChecks.milestoneUpdate(['status']))).toBe(false);
    expect(checkPermission(config, PermissionChecks.taskDelete())).toBe(false);
    expect(checkPermission(config, PermissionChecks.taskUpdate(['assignee']))).toBe(true);
  });
});

describe('PermissionChecks helpers', () => {
  it('creates correct task checks', () => {
    expect(PermissionChecks.taskList()).toEqual({ resource: 'task', action: 'list', fields: [] });
    expect(PermissionChecks.taskShow()).toEqual({ resource: 'task', action: 'show', fields: [] });
    expect(PermissionChecks.taskCreate()).toEqual({
      resource: 'task',
      action: 'create',
      fields: [],
    });
    expect(PermissionChecks.taskUpdate(['status'])).toEqual({
      resource: 'task',
      action: 'update',
      fields: ['status'],
    });
    expect(PermissionChecks.taskDelete()).toEqual({
      resource: 'task',
      action: 'delete',
      fields: [],
    });
  });

  it('creates correct milestone checks', () => {
    expect(PermissionChecks.milestoneList()).toEqual({
      resource: 'milestone',
      action: 'list',
      fields: [],
    });
    expect(PermissionChecks.milestoneCreate()).toEqual({
      resource: 'milestone',
      action: 'create',
      fields: [],
    });
    expect(PermissionChecks.milestoneUpdate(['status'])).toEqual({
      resource: 'milestone',
      action: 'update',
      fields: ['status'],
    });
  });

  it('creates correct doc checks', () => {
    expect(PermissionChecks.docRead()).toEqual({ resource: 'doc', action: 'read', fields: [] });
    expect(PermissionChecks.docUpdate()).toEqual({ resource: 'doc', action: 'update', fields: [] });
  });

  it('creates correct team checks', () => {
    expect(PermissionChecks.teamCreate()).toEqual({
      resource: 'team',
      action: 'create',
      fields: [],
    });
    expect(PermissionChecks.teamList()).toEqual({ resource: 'team', action: 'list', fields: [] });
  });

  it('creates correct log checks', () => {
    expect(PermissionChecks.logRead()).toEqual({ resource: 'log', action: 'read', fields: [] });
  });
});
