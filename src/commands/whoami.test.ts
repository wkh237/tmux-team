import { describe, expect, it, vi } from 'vitest';
import { cmdWhoami } from './whoami.js';
import { cmdUnbind } from './unbind.js';
import type { ActiveRegistration } from '../domain/types.js';
import type { Context } from '../types.js';

function context(registrations: ActiveRegistration[] = [], json = false): Context {
  const tmux: Context['tmux'] = {
    send: vi.fn(),
    capture: vi.fn(),
    listPanes: vi.fn(() => []),
    getCurrentPaneId: vi.fn(() => '%1'),
    resolvePaneTarget: vi.fn((target: string) => target),
    setPaneTitle: vi.fn(),
    getAgentRegistry: vi.fn(() => ({ paneRegistry: {}, agents: {} })),
    setAgentRegistration: vi.fn(),
    clearAgentRegistration: vi.fn(() => false),
    listGlobalIdentities: vi.fn(() => registrations),
    setGlobalIdentity: vi.fn(),
    clearGlobalIdentity: vi.fn(() => true),
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
    paths: {
      globalDir: '',
      globalConfig: '',
      localConfig: '',
      stateFile: '',
      databaseFile: '',
    },
    exit: ((code: number) => {
      throw Object.assign(new Error(`exit(${code})`), { exitCode: code });
    }) as Context['exit'],
  };
}

describe('whoami and unbind', () => {
  it('reports bound identity as JSON', () => {
    const ctx = context([{ name: 'alice', canonicalName: 'alice', paneId: '%1' }], true);
    cmdWhoami(ctx);
    expect(ctx.ui.json).toHaveBeenCalledWith({ bound: true, name: 'alice', pane: '%1' });
  });

  it('reports bound identity in concise human output', () => {
    const ctx = context([{ name: 'alice', canonicalName: 'alice', paneId: '%1' }]);
    cmdWhoami(ctx);
    expect(ctx.ui.info).toHaveBeenCalledWith("Bound identity 'alice' on pane %1");
  });

  it('reports an unbound pane successfully', () => {
    const ctx = context([], true);
    cmdWhoami(ctx);
    expect(ctx.ui.json).toHaveBeenCalledWith({ bound: false, pane: '%1' });
  });

  it('reports an unbound pane in concise human output', () => {
    const ctx = context();
    cmdWhoami(ctx);
    expect(ctx.ui.info).toHaveBeenCalledWith('Pane %1 is unbound.');
  });

  it('unbinds only the current pane', () => {
    const ctx = context([
      { name: 'alice', canonicalName: 'alice', paneId: '%1' },
      { name: 'bob', canonicalName: 'bob', paneId: '%2' },
    ]);
    cmdUnbind(ctx);
    expect(ctx.tmux.clearGlobalIdentity).toHaveBeenCalledWith('%1');
  });

  it('returns exact JSON for successful unbind', () => {
    const ctx = context([{ name: 'alice', canonicalName: 'alice', paneId: '%1' }], true);
    cmdUnbind(ctx);
    expect(ctx.ui.json).toHaveBeenCalledWith({ unbound: true, name: 'alice', pane: '%1' });
  });

  it('returns UNBOUND_PANE without mutation when repeated', () => {
    const ctx = context([], true);
    (ctx.tmux.clearGlobalIdentity as ReturnType<typeof vi.fn>).mockReturnValue(false);
    expect(() => cmdUnbind(ctx)).toThrow('exit(1)');
    expect(ctx.ui.json).toHaveBeenCalledWith({
      error: { code: 'UNBOUND_PANE', message: 'Pane has no active global name.' },
    });
  });

  it('returns a pane-not-found error when outside tmux', () => {
    const ctx = context([], true);
    (ctx.tmux.getCurrentPaneId as ReturnType<typeof vi.fn>).mockReturnValue(null);
    expect(() => cmdWhoami(ctx)).toThrow('exit(3)');
    expect(ctx.ui.json).toHaveBeenCalledWith({
      error: { code: 'PANE_NOT_FOUND', message: 'Not running inside a resolvable tmux pane.' },
    });
  });
});
