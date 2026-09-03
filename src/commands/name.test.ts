import { describe, expect, it, vi } from 'vitest';
import { cmdName } from './name.js';
import { cmdThis } from './this.js';
import { cmdAdd } from './add.js';
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
    paths: { globalDir: '', globalConfig: '', localConfig: '', stateFile: '' },
    exit: ((code: number) => {
      throw Object.assign(new Error(`exit(${code})`), { exitCode: code });
    }) as Context['exit'],
  };
}

const active = (name: string, paneId: string): ActiveRegistration => ({
  name,
  canonicalName: name.toLowerCase(),
  paneId,
});

describe('global identity commands', () => {
  it('binds the current pane and writes canonical metadata', () => {
    const ctx = context();
    cmdName(ctx, 'Backend');
    expect(ctx.tmux.setGlobalIdentity).toHaveBeenCalledWith('%1', 'Backend');
    expect(ctx.tmux.setPaneTitle).toHaveBeenCalledWith('%1', 'Backend');
    expect(ctx.ui.success).toHaveBeenCalledWith("Bound 'Backend' to pane %1");
  });

  it('uses the exact same implementation for this', () => {
    const ctx = context();
    cmdThis(ctx, 'backend');
    expect(ctx.tmux.setGlobalIdentity).toHaveBeenCalledWith('%1', 'backend');
    expect(ctx.ui.error).not.toHaveBeenCalled();
  });

  it('keeps human success output exactly identical between name and this', () => {
    const nameCtx = context();
    const thisCtx = context();
    cmdName(nameCtx, 'backend');
    cmdThis(thisCtx, 'backend');
    expect(thisCtx.ui.success).toHaveBeenCalledWith(
      (nameCtx.ui.success as ReturnType<typeof vi.fn>).mock.calls[0][0]
    );
  });

  it('keeps JSON success output exactly identical between name and this', () => {
    const nameCtx = context([], true);
    const thisCtx = context([], true);
    cmdName(nameCtx, 'backend');
    cmdThis(thisCtx, 'backend');
    expect(thisCtx.ui.json).toHaveBeenCalledWith(
      (nameCtx.ui.json as ReturnType<typeof vi.fn>).mock.calls[0][0]
    );
  });

  it('keeps semantic failure code, message, and exit identical between name and this', () => {
    const nameCtx = context([active('Alice', '%2')], true);
    const thisCtx = context([active('Alice', '%2')], true);
    let nameError: unknown;
    let thisError: unknown;
    try {
      cmdName(nameCtx, 'alice');
    } catch (error) {
      nameError = error;
    }
    try {
      cmdThis(thisCtx, 'alice');
    } catch (error) {
      thisError = error;
    }
    expect((nameError as Error & { exitCode: number }).exitCode).toBe(5);
    expect((thisError as Error & { exitCode: number }).exitCode).toBe(5);
    expect(nameCtx.ui.json).toHaveBeenCalledWith(
      (thisCtx.ui.json as ReturnType<typeof vi.fn>).mock.calls[0][0]
    );
    expect(nameCtx.ui.warn).not.toHaveBeenCalled();
    expect(thisCtx.ui.warn).not.toHaveBeenCalled();
  });

  it.each(['10.3', '%14', 'session:2.1'])('binds an explicit target: %s', (target) => {
    const ctx = context();
    (ctx.tmux.resolvePaneTarget as ReturnType<typeof vi.fn>).mockReturnValue('%14');
    cmdAdd(ctx, target, 'server-log');
    expect(ctx.tmux.setGlobalIdentity).toHaveBeenCalledWith('%14', 'server-log');
  });

  it('rejects a stale explicit target before any name or metadata work', () => {
    const ctx = context([], true);
    (ctx.tmux.resolvePaneTarget as ReturnType<typeof vi.fn>).mockReturnValue(null);
    expect(() => cmdAdd(ctx, '10.3', 'server-log')).toThrow('exit(3)');
    expect(ctx.ui.json).toHaveBeenCalledWith({
      error: { code: 'PANE_NOT_FOUND', message: "Pane target '10.3' was not found." },
    });
    expect(ctx.tmux.listGlobalIdentities).not.toHaveBeenCalled();
    expect(ctx.tmux.setGlobalIdentity).not.toHaveBeenCalled();
    expect(ctx.tmux.setPaneTitle).not.toHaveBeenCalled();
  });

  it('returns deterministic JSON for binding output', () => {
    const ctx = context([], true);
    cmdName(ctx, 'alice');
    expect(ctx.ui.json).toHaveBeenCalledWith({ bound: true, name: 'alice', pane: '%1' });
  });

  it.each(['', '  ', 'bad\nname', '%14', '10.3', 'session:2.1'])(
    'rejects invalid names without writing: %j',
    (name) => {
      const ctx = context();
      expect(() => cmdName(ctx, name)).toThrow('exit(1)');
      expect(ctx.tmux.setGlobalIdentity).not.toHaveBeenCalled();
    }
  );

  it('reports name conflicts without mutation', () => {
    const ctx = context([active('Alice', '%2')]);
    expect(() => cmdName(ctx, 'alice')).toThrow('exit(5)');
    expect(ctx.tmux.setGlobalIdentity).not.toHaveBeenCalled();
  });

  it('reports NAME_ALREADY_ACTIVE as structured JSON without mutation', () => {
    const ctx = context([active('Alice', '%2')], true);
    expect(() => cmdName(ctx, 'alice')).toThrow('exit(5)');
    expect(ctx.ui.json).toHaveBeenCalledWith({
      error: { code: 'NAME_ALREADY_ACTIVE', message: 'Name is already active on another pane.' },
    });
    expect(ctx.tmux.setGlobalIdentity).not.toHaveBeenCalled();
    expect(ctx.tmux.setPaneTitle).not.toHaveBeenCalled();
  });

  it('reports PANE_ALREADY_BOUND as structured JSON without mutation', () => {
    const ctx = context([active('Alice', '%1')], true);
    expect(() => cmdName(ctx, 'other')).toThrow('exit(5)');
    expect(ctx.ui.json).toHaveBeenCalledWith({
      error: { code: 'PANE_ALREADY_BOUND', message: 'Pane is already bound to another name.' },
    });
    expect(ctx.tmux.setGlobalIdentity).not.toHaveBeenCalled();
    expect(ctx.tmux.setPaneTitle).not.toHaveBeenCalled();
  });

  it('reports INVALID_NAME as structured JSON without mutation', () => {
    const ctx = context([], true);
    expect(() => cmdName(ctx, '%14')).toThrow('exit(1)');
    expect(ctx.ui.json).toHaveBeenCalledWith({
      error: { code: 'INVALID_NAME', message: 'Identity name must not look like a pane target.' },
    });
    expect(ctx.tmux.setGlobalIdentity).not.toHaveBeenCalled();
    expect(ctx.tmux.setPaneTitle).not.toHaveBeenCalled();
  });

  it('trims display names while comparing canonical names case-insensitively', () => {
    const ctx = context();
    cmdName(ctx, '  Backend  ');
    expect(ctx.tmux.setGlobalIdentity).toHaveBeenCalledWith('%1', 'Backend');
  });

  it('is idempotent for the same canonical name and pane', () => {
    const ctx = context([active('Alice', '%1')]);
    cmdName(ctx, ' alice ');
    expect(ctx.tmux.setGlobalIdentity).not.toHaveBeenCalled();
  });

  it('treats NFKC-equivalent names as the same active identity', () => {
    const ctx = context([active('Alice', '%1')]);
    cmdName(ctx, 'ＡＬＩＣＥ');
    expect(ctx.tmux.setGlobalIdentity).not.toHaveBeenCalled();
  });

  it('does not fail a successful bind when title synchronization fails', () => {
    const ctx = context();
    (ctx.tmux.setPaneTitle as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('title unavailable');
    });
    cmdName(ctx, 'backend');
    expect(ctx.tmux.setGlobalIdentity).toHaveBeenCalledWith('%1', 'backend');
    expect(ctx.ui.success).toHaveBeenCalled();
  });
});
