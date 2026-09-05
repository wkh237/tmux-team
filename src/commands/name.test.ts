import { describe, expect, it, vi } from 'vitest';
import { cmdName } from './name.js';
import { cmdThis } from './this.js';
import { cmdAdd } from './add.js';
import { IdentityServiceError } from '../identity-service.js';
import type { Context, IdentityService } from '../types.js';

function identity(name: string = 'Backend') {
  return {
    id: 'backend-id',
    name,
    canonicalName: name.trim().toLowerCase(),
    createdAt: 'created',
    updatedAt: 'updated',
  };
}

function context(json = false): Context {
  const tmux: Context['tmux'] = {
    send: vi.fn(),
    capture: vi.fn(),
    listPanes: vi.fn(() => []),
    getCurrentPaneId: vi.fn(() => '%1'),
    resolvePaneTarget: vi.fn((target: string) => target),
    setPaneTitle: vi.fn(),
  };
  const identityService: IdentityService = {
    bindCurrent: vi.fn(() => identity()),
    bindPane: vi.fn(() => identity()),
    unbindCurrent: vi.fn(),
    currentIdentity: vi.fn(),
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
    tmux,
    identityService,
    get requestService(): Context['requestService'] {
      throw new Error('Unexpected request service access.');
    },
    paths: { globalDir: '', globalConfig: '', localConfig: '', stateFile: '', databaseFile: '' },
    exit: ((code: number) => {
      throw Object.assign(new Error(`exit(${code})`), { exitCode: code });
    }) as Context['exit'],
  };
}

describe('global identity commands', () => {
  it('never selects the name-only writer when required service wiring is absent', () => {
    const ctx = context();
    const legacyRead = vi.fn(() => []);
    const legacyWrite = vi.fn();
    Object.assign(ctx.tmux, { listGlobalIdentities: legacyRead, setGlobalIdentity: legacyWrite });
    Object.defineProperty(ctx, 'identityService', { value: undefined });
    expect(() => cmdName(ctx, 'Backend')).toThrow();
    expect(legacyRead).not.toHaveBeenCalled();
    expect(legacyWrite).not.toHaveBeenCalled();
    expect(ctx.tmux.setPaneTitle).not.toHaveBeenCalled();
    expect(ctx.ui.success).not.toHaveBeenCalled();
  });
  it('binds the current pane through the durable service and keeps title output', () => {
    const ctx = context();
    cmdName(ctx, 'Backend');
    expect(ctx.identityService.bindCurrent).toHaveBeenCalledWith('Backend');
    expect(ctx.tmux.setPaneTitle).toHaveBeenCalledWith('%1', 'Backend');
    expect(ctx.ui.success).toHaveBeenCalledWith("Bound 'Backend' to pane %1");
  });

  it('uses the same service path for this', () => {
    const ctx = context();
    cmdThis(ctx, 'backend');
    expect(ctx.identityService.bindCurrent).toHaveBeenCalledWith('backend');
    expect(ctx.ui.error).not.toHaveBeenCalled();
  });

  it('keeps human and JSON success output identical between name and this', () => {
    const humanName = context();
    const humanThis = context();
    cmdName(humanName, 'backend');
    cmdThis(humanThis, 'backend');
    expect(humanThis.ui.success).toHaveBeenCalledWith(
      (humanName.ui.success as ReturnType<typeof vi.fn>).mock.calls[0][0]
    );

    const jsonName = context(true);
    const jsonThis = context(true);
    cmdName(jsonName, 'backend');
    cmdThis(jsonThis, 'backend');
    expect(jsonName.ui.json).toHaveBeenCalledWith({ bound: true, name: 'Backend', pane: '%1' });
    expect(jsonThis.ui.json).toHaveBeenCalledWith(
      (jsonName.ui.json as ReturnType<typeof vi.fn>).mock.calls[0][0]
    );
  });

  it.each(['10.3', '%14', 'session:2.1'])(
    'binds explicit target %s through the durable service',
    (target) => {
      const ctx = context();
      (ctx.tmux.resolvePaneTarget as ReturnType<typeof vi.fn>).mockReturnValue('%14');
      cmdAdd(ctx, target, 'server-log');
      expect(ctx.tmux.resolvePaneTarget).toHaveBeenCalledWith(target);
      expect(ctx.identityService.bindPane).toHaveBeenCalledOnce();
      expect(ctx.identityService.bindPane).toHaveBeenCalledWith('%14', 'server-log');
    }
  );

  it('rejects a stale explicit target before service work', () => {
    const ctx = context(true);
    (ctx.tmux.resolvePaneTarget as ReturnType<typeof vi.fn>).mockReturnValue(null);
    expect(() => cmdAdd(ctx, '10.3', 'server-log')).toThrow('exit(3)');
    expect(ctx.identityService.bindPane).not.toHaveBeenCalled();
    expect(ctx.ui.json).toHaveBeenCalledWith({
      error: { code: 'PANE_NOT_FOUND', message: "Pane target '10.3' was not found." },
    });
  });

  it('maps durable service errors without a fallback', () => {
    const ctx = context(true);
    (ctx.identityService.bindCurrent as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new IdentityServiceError(
        'NAME_ALREADY_ACTIVE',
        'Name is already active on another pane.'
      );
    });
    expect(() => cmdName(ctx, 'backend')).toThrow('exit(5)');
    expect(ctx.ui.json).toHaveBeenCalledWith({
      error: { code: 'NAME_ALREADY_ACTIVE', message: 'Name is already active on another pane.' },
    });
    expect(ctx.tmux.setPaneTitle).not.toHaveBeenCalled();
  });

  it.each([
    ['PANE_ALREADY_BOUND', 5],
    ['NAME_ALREADY_ACTIVE', 5],
    ['RECONCILIATION_FAILED', 1],
  ] as const)('maps typed service error %s to exit %i', (code, exitCode) => {
    const ctx = context(true);
    (ctx.identityService.bindCurrent as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new IdentityServiceError(code, `failure: ${code}`);
    });
    expect(() => cmdName(ctx, 'backend')).toThrow(`exit(${exitCode})`);
    expect(ctx.ui.json).toHaveBeenCalledWith({ error: { code, message: `failure: ${code}` } });
  });

  it('passes validation errors to the durable service boundary', () => {
    const ctx = context(true);
    (ctx.identityService.bindCurrent as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new IdentityServiceError(
        'INVALID_NAME',
        'Identity name must not look like a pane target.'
      );
    });
    expect(() => cmdName(ctx, '%14')).toThrow('exit(1)');
    expect(ctx.ui.json).toHaveBeenCalledWith({
      error: { code: 'INVALID_NAME', message: 'Identity name must not look like a pane target.' },
    });
  });

  it('uses verified current-pane binding without resolving the pane again', () => {
    const ctx = context();
    cmdName(ctx, 'backend');
    expect(ctx.identityService.bindCurrent).toHaveBeenCalledWith('backend');
    expect(ctx.tmux.resolvePaneTarget).not.toHaveBeenCalled();
  });

  it('keeps name and this failure output and exit identical', () => {
    const contexts = [context(true), context(true)];
    for (const [index, handler] of [cmdName, cmdThis].entries()) {
      const ctx = contexts[index];
      vi.mocked(ctx.identityService.bindCurrent).mockImplementation(() => {
        throw new IdentityServiceError(
          'NAME_ALREADY_ACTIVE',
          'Name is already active on another pane.'
        );
      });
      expect(() => handler(ctx, 'alice')).toThrow('exit(5)');
      expect(ctx.ui.json).toHaveBeenCalledOnce();
      expect(ctx.tmux.setPaneTitle).not.toHaveBeenCalled();
    }
    expect(vi.mocked(contexts[0].ui.json).mock.calls).toEqual(
      vi.mocked(contexts[1].ui.json).mock.calls
    );
  });

  it('keeps a successful bind when title synchronization fails', () => {
    const ctx = context();
    (ctx.tmux.setPaneTitle as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('title unavailable');
    });
    cmdName(ctx, 'backend');
    expect(ctx.identityService.bindCurrent).toHaveBeenCalledWith('backend');
    expect(ctx.ui.success).toHaveBeenCalled();
  });
});
