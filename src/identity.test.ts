import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PaneEntry } from './types.js';
import { resolveActor } from './identity.js';
import { execSync } from 'child_process';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

const mockedExec = vi.mocked(execSync);

describe('resolveActor', () => {
  const paneRegistry: Record<string, PaneEntry> = {
    claude: { pane: '10.0' },
    codex: { pane: '10.1' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.TMT_AGENT_NAME;
    delete process.env.TMUX_TEAM_ACTOR;
    delete process.env.TMUX;
    delete process.env.TMUX_PANE;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns default actor when not in tmux and no env var', () => {
    const res = resolveActor(paneRegistry);
    expect(res).toEqual({ actor: 'human', source: 'default' });
  });

  it('uses env actor when not in tmux', () => {
    process.env.TMT_AGENT_NAME = 'claude';
    const res = resolveActor(paneRegistry);
    expect(res).toEqual({ actor: 'claude', source: 'env' });
  });

  it('uses pane identity when in tmux and pane matches registry', () => {
    process.env.TMUX = '1';
    process.env.TMUX_PANE = '%99';
    mockedExec.mockReturnValue('10.1\n');
    const res = resolveActor(paneRegistry);
    expect(res.actor).toBe('codex');
    expect(res.source).toBe('pane');
  });

  it('warns on identity mismatch (env vs pane)', () => {
    process.env.TMUX = '1';
    process.env.TMUX_PANE = '%99';
    process.env.TMT_AGENT_NAME = 'claude';
    mockedExec.mockReturnValue('10.1\n');
    const res = resolveActor(paneRegistry);
    expect(res.actor).toBe('codex');
    expect(res.warning).toContain('Identity mismatch');
  });

  it('uses env actor with warning when pane is unregistered', () => {
    process.env.TMUX = '1';
    process.env.TMUX_PANE = '%99';
    process.env.TMT_AGENT_NAME = 'someone';
    mockedExec.mockReturnValue('99.9\n');
    const res = resolveActor(paneRegistry);
    expect(res.actor).toBe('someone');
    expect(res.source).toBe('env');
    expect(res.warning).toContain('Unregistered pane');
  });
});
