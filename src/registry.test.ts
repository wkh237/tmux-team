import { describe, expect, it } from 'vitest';
import type { Context } from './types.js';
import { getRegistryScope, registrationFromEntry, scopeLabel } from './registry.js';

function ctx(overrides: Partial<Context>): Context {
  return {
    argv: [],
    flags: { json: false, verbose: false },
    ui: {} as Context['ui'],
    config: {} as Context['config'],
    tmux: {} as Context['tmux'],
    paths: {
      globalDir: '/g',
      globalConfig: '/g/c',
      localConfig: '/r/tmux-team.json',
      stateFile: '/g/s',
      workspaceRoot: '/repo',
    },
    exit: (() => {
      throw new Error('exit');
    }) as Context['exit'],
    ...overrides,
  };
}

describe('registry helpers', () => {
  it('prefers explicit context registry scope', () => {
    const scope = { type: 'team' as const, teamName: 'egp' };
    expect(getRegistryScope(ctx({ registryScope: scope }))).toBe(scope);
  });

  it('uses --team when no explicit scope exists', () => {
    expect(getRegistryScope(ctx({ flags: { json: false, verbose: false, team: 'egp' } }))).toEqual({
      type: 'team',
      teamName: 'egp',
    });
  });

  it('falls back to workspace scope', () => {
    expect(getRegistryScope(ctx({}))).toEqual({ type: 'workspace', workspaceRoot: '/repo' });
    expect(scopeLabel({ type: 'workspace', workspaceRoot: '/repo' })).toBe('workspace /repo');
    expect(scopeLabel({ type: 'team', teamName: 'egp' })).toBe('team "egp"');
  });

  it('converts pane entries into registrations', () => {
    expect(
      registrationFromEntry('codex', {
        pane: '%1',
        remark: 'review',
        preamble: 'Be strict',
        deny: ['x'],
      })
    ).toEqual({
      name: 'codex',
      remark: 'review',
      preamble: 'Be strict',
      deny: ['x'],
    });
    expect(registrationFromEntry('codex')).toEqual({ name: 'codex' });
  });
});
