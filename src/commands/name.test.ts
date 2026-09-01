import { describe, expect, it, vi } from 'vitest';
import { cmdName } from './name.js';
import type { Context } from '../types.js';

function context(overrides: Partial<Context['tmux']> = {}, json = false): Context {
  const tmux: Context['tmux'] = {
    send: vi.fn(),
    capture: vi.fn(),
    listPanes: vi.fn(() => []),
    getCurrentPaneId: vi.fn(() => '%1'),
    resolvePaneTarget: vi.fn((target: string) => (target === 'main:1.2' ? '%9' : target)),
    setPaneTitle: vi.fn(),
    getAgentRegistry: vi.fn(() => ({ paneRegistry: {}, agents: {} })),
    setAgentRegistration: vi.fn(),
    clearAgentRegistration: vi.fn(() => false),
    listTeams: vi.fn(() => ({})),
    listTeamPanes: vi.fn(() => []),
    removeTeam: vi.fn(() => ({ removed: 0, agents: [] })),
    ...overrides,
  };
  return {
    argv: [],
    flags: { json, verbose: false },
    ui: {
      info: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      table: vi.fn(),
      json: vi.fn(),
    },
    config: {
      mode: 'polling',
      preambleMode: 'always',
      defaults: {
        timeout: 1,
        pollInterval: 1,
        captureLines: 1,
        maxCaptureLines: 1,
        preambleEvery: 1,
        pasteEnterDelayMs: 0,
      },
      agents: {},
      paneRegistry: {},
    },
    tmux,
    paths: { globalDir: '', globalConfig: '', localConfig: '', stateFile: '' },
    exit: ((code: number) => {
      throw Object.assign(new Error(`exit(${code})`), { exitCode: code });
    }) as Context['exit'],
  };
}

describe('cmdName', () => {
  it('names the current pane by default', () => {
    const ctx = context();
    cmdName(ctx, 'backend');
    expect(ctx.tmux.resolvePaneTarget).toHaveBeenCalledWith('%1');
    expect(ctx.tmux.setPaneTitle).toHaveBeenCalledWith('%1', 'backend');
    expect(ctx.ui.success).toHaveBeenCalled();
  });

  it('resolves an explicit pane target and supports JSON output', () => {
    const ctx = context({}, true);
    cmdName(ctx, 'frontend', 'main:1.2');
    expect(ctx.tmux.setPaneTitle).toHaveBeenCalledWith('%9', 'frontend');
    expect(ctx.ui.json).toHaveBeenCalledWith({ named: 'frontend', pane: '%9' });
  });

  it.each(['', '   ', 'bad\nname', 'bad\u0007name'])('rejects invalid names: %j', (name) => {
    const ctx = context();
    expect(() => cmdName(ctx, name)).toThrow('exit(1)');
    expect(ctx.tmux.setPaneTitle).not.toHaveBeenCalled();
  });
});
