import { describe, expect, it, vi } from 'vitest';
import { cmdWhoami } from './whoami.js';
import { cmdUnbind } from './unbind.js';
import type { Context, IdentityService } from '../types.js';

function identity(name = 'alice') {
  return {
    id: `${name}-id`,
    name,
    canonicalName: name,
    createdAt: 'created',
    updatedAt: 'updated',
  };
}

function context(json = false): Context {
  const current = { identity: identity() };
  const identityService: IdentityService = {
    bindCurrent: vi.fn(),
    bindPane: vi.fn(),
    unbindCurrent: vi.fn(() => identity()),
    currentIdentity: vi.fn(() => ({
      ...current,
      binding: {
        id: 'binding-id',
        identityId: 'alice-id',
        transport: 'tmux' as const,
        paneId: '%1',
        serverId: 'server',
        socketPath: '/tmp/tmux.sock',
        serverPid: 1,
        serverStartTime: 'now',
        panePid: 1,
        boundAt: 'now',
        lastVerifiedAt: 'now',
      },
    })),
    activeIdentities: vi.fn(() => []),
    resolveActive: vi.fn(),
    reconcile: vi.fn(),
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
    },
    tmux: {
      send: vi.fn(),
      capture: vi.fn(),
      listPanes: vi.fn(() => []),
      getCurrentPaneId: vi.fn(() => '%1'),
      resolvePaneTarget: vi.fn(),
      setPaneTitle: vi.fn(),
    },
    identityService,
    paths: { globalDir: '', globalConfig: '', localConfig: '', stateFile: '', databaseFile: '' },
    exit: ((code: number) => {
      throw Object.assign(new Error(`exit(${code})`), { exitCode: code });
    }) as Context['exit'],
  };
}

describe('whoami and unbind', () => {
  it.each([cmdWhoami, cmdUnbind])(
    'fails closed without required wiring instead of using raw markers',
    (handler) => {
      const ctx = context(true);
      const legacyRead = vi.fn(() => [{ name: 'alice', canonicalName: 'alice', paneId: '%1' }]);
      const legacyClear = vi.fn(() => true);
      Object.assign(ctx.tmux, {
        listGlobalIdentities: legacyRead,
        clearGlobalIdentity: legacyClear,
      });
      Object.defineProperty(ctx, 'identityService', { value: undefined });
      expect(() => handler(ctx)).toThrow();
      expect(legacyRead).not.toHaveBeenCalled();
      expect(legacyClear).not.toHaveBeenCalled();
      expect(ctx.ui.json).not.toHaveBeenCalled();
    }
  );
  it('reports the durable current identity as JSON', () => {
    const ctx = context(true);
    cmdWhoami(ctx);
    expect(ctx.ui.json).toHaveBeenCalledWith({ bound: true, name: 'alice', pane: '%1' });
  });

  it('reports the durable current identity in concise human output', () => {
    const ctx = context();
    cmdWhoami(ctx);
    expect(ctx.ui.info).toHaveBeenCalledWith("Bound identity 'alice' on pane %1");
  });

  it('reports an unbound pane in concise human output', () => {
    const ctx = context();
    (ctx.identityService.currentIdentity as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    cmdWhoami(ctx);
    expect(ctx.ui.info).toHaveBeenCalledWith('Pane %1 is unbound.');
  });

  it('reports an unbound pane without reading tmux metadata', () => {
    const ctx = context(true);
    (ctx.identityService.currentIdentity as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    cmdWhoami(ctx);
    expect(ctx.ui.json).toHaveBeenCalledWith({ bound: false, pane: '%1' });
  });

  it('unbinds through the durable identity service', () => {
    const ctx = context(true);
    cmdUnbind(ctx);
    expect(ctx.identityService.unbindCurrent).toHaveBeenCalledOnce();
    expect(ctx.ui.json).toHaveBeenCalledWith({ unbound: true, name: 'alice', pane: '%1' });
  });

  it('maps an unbound durable result', () => {
    const ctx = context(true);
    (ctx.identityService.unbindCurrent as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    expect(() => cmdUnbind(ctx)).toThrow('exit(1)');
    expect(ctx.ui.json).toHaveBeenCalledWith({
      error: { code: 'UNBOUND_PANE', message: 'Pane has no active global name.' },
    });
  });

  it('rejects the caller before opening identity state', () => {
    const ctx = context(true);
    (ctx.tmux.getCurrentPaneId as ReturnType<typeof vi.fn>).mockReturnValue(null);
    expect(() => cmdWhoami(ctx)).toThrow('exit(3)');
    expect(ctx.identityService.currentIdentity).not.toHaveBeenCalled();
  });

  it('does not open the required service getter before caller validation', () => {
    const ctx = context(true);
    (ctx.tmux.getCurrentPaneId as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const getter = vi.fn(() => {
      throw new Error('identity service must remain unopened');
    });
    Object.defineProperty(ctx, 'identityService', { configurable: true, get: getter });
    expect(() => cmdWhoami(ctx)).toThrow('exit(3)');
    expect(getter).not.toHaveBeenCalled();
  });
});
