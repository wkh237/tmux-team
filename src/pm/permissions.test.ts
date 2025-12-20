// ─────────────────────────────────────────────────────────────
// Permission System Tests
// ─────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildPermissionPath,
  checkPermission,
  getCurrentActor,
  resolveActor,
  PermissionChecks,
} from './permissions.js';
import type { ResolvedConfig } from '../types.js';

function createMockConfig(agents: Record<string, { deny?: string[] }>): ResolvedConfig {
  return {
    mode: 'polling',
    preambleMode: 'always',
    defaults: {
      timeout: 60,
      pollInterval: 1,
      captureLines: 100,
      preambleEvery: 3,
      hideOrphanTasks: false,
    },
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
    // Disable pane detection in tests by unsetting TMUX
    delete process.env.TMUX;
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

    expect(checkPermission(config, PermissionChecks.taskUpdate(['status'])).allowed).toBe(true);
  });

  it('allows when no deny patterns for agent', () => {
    process.env.TMT_AGENT_NAME = 'codex';

    const config = createMockConfig({
      codex: {}, // No deny patterns
    });

    expect(checkPermission(config, PermissionChecks.taskUpdate(['status'])).allowed).toBe(true);
  });

  it('allows when agent not in config', () => {
    process.env.TMT_AGENT_NAME = 'unknown-agent';

    const config = createMockConfig({
      codex: { deny: ['pm:task:update(status)'] },
    });

    expect(checkPermission(config, PermissionChecks.taskUpdate(['status'])).allowed).toBe(true);
  });

  it('denies when pattern matches exactly', () => {
    process.env.TMT_AGENT_NAME = 'codex';

    const config = createMockConfig({
      codex: { deny: ['pm:task:update(status)'] },
    });

    expect(checkPermission(config, PermissionChecks.taskUpdate(['status'])).allowed).toBe(false);
  });

  it('denies when pattern matches any field', () => {
    process.env.TMT_AGENT_NAME = 'codex';

    const config = createMockConfig({
      codex: { deny: ['pm:task:update(status)'] },
    });

    // Using both status and assignee, should still be denied because status is in deny list
    expect(
      checkPermission(config, PermissionChecks.taskUpdate(['status', 'assignee'])).allowed
    ).toBe(false);
  });

  it('allows when fields do not match', () => {
    process.env.TMT_AGENT_NAME = 'codex';

    const config = createMockConfig({
      codex: { deny: ['pm:task:update(status)'] },
    });

    // Only updating assignee, not status
    expect(checkPermission(config, PermissionChecks.taskUpdate(['assignee'])).allowed).toBe(true);
  });

  it('denies entire action when pattern has no fields', () => {
    process.env.TMT_AGENT_NAME = 'codex';

    const config = createMockConfig({
      codex: { deny: ['pm:task:update'] },
    });

    // Any update should be denied
    expect(checkPermission(config, PermissionChecks.taskUpdate(['status'])).allowed).toBe(false);
    expect(checkPermission(config, PermissionChecks.taskUpdate(['assignee'])).allowed).toBe(false);
    expect(checkPermission(config, PermissionChecks.taskUpdate([])).allowed).toBe(false);
  });

  it('denies when wildcard pattern matches any field', () => {
    process.env.TMT_AGENT_NAME = 'codex';

    const config = createMockConfig({
      codex: { deny: ['pm:task:update(*)'] },
    });

    expect(checkPermission(config, PermissionChecks.taskUpdate(['status'])).allowed).toBe(false);
    expect(checkPermission(config, PermissionChecks.taskUpdate(['assignee'])).allowed).toBe(false);
  });

  it('allows no-field action when wildcard is used', () => {
    process.env.TMT_AGENT_NAME = 'codex';

    const config = createMockConfig({
      codex: { deny: ['pm:task:update(*)'] },
    });

    // Wildcard only matches when fields are present
    expect(checkPermission(config, PermissionChecks.taskUpdate([])).allowed).toBe(true);
  });

  it('allows different resource', () => {
    process.env.TMT_AGENT_NAME = 'codex';

    const config = createMockConfig({
      codex: { deny: ['pm:task:update(status)'] },
    });

    expect(checkPermission(config, PermissionChecks.milestoneUpdate(['status'])).allowed).toBe(
      true
    );
  });

  it('allows different action', () => {
    process.env.TMT_AGENT_NAME = 'codex';

    const config = createMockConfig({
      codex: { deny: ['pm:task:update(status)'] },
    });

    expect(checkPermission(config, PermissionChecks.taskCreate()).allowed).toBe(true);
    expect(checkPermission(config, PermissionChecks.taskList()).allowed).toBe(true);
  });

  it('handles multiple deny patterns', () => {
    process.env.TMT_AGENT_NAME = 'codex';

    const config = createMockConfig({
      codex: {
        deny: ['pm:task:update(status)', 'pm:milestone:update(status)', 'pm:task:delete'],
      },
    });

    expect(checkPermission(config, PermissionChecks.taskUpdate(['status'])).allowed).toBe(false);
    expect(checkPermission(config, PermissionChecks.milestoneUpdate(['status'])).allowed).toBe(
      false
    );
    expect(checkPermission(config, PermissionChecks.taskDelete()).allowed).toBe(false);
    expect(checkPermission(config, PermissionChecks.taskUpdate(['assignee'])).allowed).toBe(true);
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

describe('resolveActor', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns human when not in tmux and no env var', () => {
    delete process.env.TMUX;
    delete process.env.TMT_AGENT_NAME;
    delete process.env.TMUX_TEAM_ACTOR;

    const result = resolveActor({});
    expect(result.actor).toBe('human');
    expect(result.source).toBe('default');
    expect(result.warning).toBeUndefined();
  });

  it('uses env var when not in tmux', () => {
    delete process.env.TMUX;
    process.env.TMT_AGENT_NAME = 'codex';

    const result = resolveActor({});
    expect(result.actor).toBe('codex');
    expect(result.source).toBe('env');
    expect(result.warning).toBeUndefined();
  });

  it('prefers TMT_AGENT_NAME over TMUX_TEAM_ACTOR', () => {
    delete process.env.TMUX;
    process.env.TMT_AGENT_NAME = 'codex';
    process.env.TMUX_TEAM_ACTOR = 'gemini';

    const result = resolveActor({});
    expect(result.actor).toBe('codex');
    expect(result.source).toBe('env');
  });
});

describe('checkPermission with local config (integration)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.TMUX;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // Helper to create config as if loaded from local tmux-team.json
  function createConfigWithLocalPermissions(
    localAgents: Record<string, { preamble?: string; deny?: string[] }>
  ): ResolvedConfig {
    return {
      mode: 'polling',
      preambleMode: 'always',
      defaults: {
        timeout: 60,
        pollInterval: 1,
        captureLines: 100,
        preambleEvery: 3,
        hideOrphanTasks: false,
      },
      agents: localAgents, // This simulates merged local config
      paneRegistry: {},
    };
  }

  it('enforces local deny rules for specific agent', () => {
    process.env.TMT_AGENT_NAME = 'claude';

    // Simulates local config with: claude has deny rules, codex does not
    const config = createConfigWithLocalPermissions({
      claude: { deny: ['pm:task:update(status)', 'pm:milestone:update(status)'] },
      codex: { preamble: 'Code quality guard' }, // No deny
    });

    // Claude is blocked from status updates
    expect(checkPermission(config, PermissionChecks.taskUpdate(['status'])).allowed).toBe(false);
    expect(checkPermission(config, PermissionChecks.milestoneUpdate(['status'])).allowed).toBe(
      false
    );

    // Claude can still do other things
    expect(checkPermission(config, PermissionChecks.taskCreate()).allowed).toBe(true);
    expect(checkPermission(config, PermissionChecks.taskList()).allowed).toBe(true);
    expect(checkPermission(config, PermissionChecks.taskUpdate(['assignee'])).allowed).toBe(true);
  });

  it('allows agent without deny rules to do everything', () => {
    process.env.TMT_AGENT_NAME = 'codex';

    const config = createConfigWithLocalPermissions({
      claude: { deny: ['pm:task:update(status)'] },
      codex: { preamble: 'Code quality guard' }, // No deny
    });

    // Codex can do everything including status updates
    expect(checkPermission(config, PermissionChecks.taskUpdate(['status'])).allowed).toBe(true);
    expect(checkPermission(config, PermissionChecks.milestoneUpdate(['status'])).allowed).toBe(
      true
    );
    expect(checkPermission(config, PermissionChecks.taskCreate()).allowed).toBe(true);
    expect(checkPermission(config, PermissionChecks.taskDelete()).allowed).toBe(true);
  });

  it('project-specific permissions: implementer vs reviewer roles', () => {
    // Real-world scenario: claude implements, codex reviews
    const config = createConfigWithLocalPermissions({
      claude: {
        preamble: 'You implement features. Ask Codex for review before marking done.',
        deny: ['pm:task:update(status)', 'pm:milestone:update(status)'],
      },
      codex: {
        preamble: 'You are the code quality guard. Mark tasks done after reviewing.',
        // No deny - codex can update status
      },
    });

    // Claude cannot mark tasks done
    process.env.TMT_AGENT_NAME = 'claude';
    expect(checkPermission(config, PermissionChecks.taskUpdate(['status'])).allowed).toBe(false);

    // Codex can mark tasks done
    process.env.TMT_AGENT_NAME = 'codex';
    expect(checkPermission(config, PermissionChecks.taskUpdate(['status'])).allowed).toBe(true);
  });

  it('returns correct result when permission denied', () => {
    process.env.TMT_AGENT_NAME = 'claude';

    const config = createConfigWithLocalPermissions({
      claude: { deny: ['pm:task:update(status)'] },
    });

    const result = checkPermission(config, PermissionChecks.taskUpdate(['status']));

    expect(result.allowed).toBe(false);
    expect(result.actor).toBe('claude');
    expect(result.source).toBe('env');
  });
});
