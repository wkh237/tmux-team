import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Paths, ResolvedConfig, UI, Tmux } from './types.js';

describe('createContext', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('wires argv, flags, paths, config, ui, tmux', async () => {
    vi.resetModules();

    const paths: Paths = {
      globalDir: '/g',
      globalConfig: '/g/config.json',
      localConfig: '/p/tmux-team.json',
      stateFile: '/g/state.json',
      databaseFile: '/g/tmux-team.db',
    };
    const config: ResolvedConfig = {
      mode: 'polling',
      preambleMode: 'always',
      defaults: {
        timeout: 180,
        pollInterval: 1,
        captureLines: 100,
        maxCaptureLines: 2000,
        preambleEvery: 3,
        pasteEnterDelayMs: 500,
      },
    };
    const ui: UI = {
      info: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      table: vi.fn(),
      json: vi.fn(),
    };
    const tmux: Tmux = {
      send: vi.fn(),
      capture: vi.fn(),
      listPanes: vi.fn(() => []),
      getCurrentPaneId: vi.fn(() => null),
      resolvePaneTarget: vi.fn((target: string) => target),
      setPaneTitle: vi.fn(),
    };

    const loadConfig = vi.fn(() => config);
    vi.doMock('./config.js', () => ({
      resolvePaths: () => paths,
      loadConfig,
    }));
    vi.doMock('./ui.js', () => ({ createUI: () => ui }));
    const createTmux = vi.fn(() => tmux);
    vi.doMock('./tmux.js', () => ({ createTmux }));

    const { createContext } = await import('./context.js');
    const ctx = createContext({ argv: ['a'], flags: { json: false, verbose: false }, cwd: '/p' });

    expect(ctx.argv).toEqual(['a']);
    expect(ctx.paths).toEqual(paths);
    expect(ctx.config).toEqual(config);
    expect(ctx.ui).toBe(ui);
    expect(ctx.tmux).toBe(tmux);
    expect(loadConfig).toHaveBeenCalledWith(paths);
  });

  it('loads storage settings without constructing a runtime registry', async () => {
    vi.resetModules();

    const paths: Paths = {
      globalDir: '/g',
      globalConfig: '/g/config.json',
      localConfig: '/repo/tmux-team.json',
      stateFile: '/g/state.json',
      databaseFile: '/g/tmux-team.db',
    };
    const config: ResolvedConfig = {
      mode: 'polling',
      preambleMode: 'always',
      defaults: {
        timeout: 180,
        pollInterval: 1,
        captureLines: 100,
        maxCaptureLines: 2000,
        preambleEvery: 3,
        pasteEnterDelayMs: 500,
      },
    };
    const tmux: Tmux = {
      send: vi.fn(),
      capture: vi.fn(),
      listPanes: vi.fn(() => []),
      getCurrentPaneId: vi.fn(() => null),
      resolvePaneTarget: vi.fn((target: string) => target),
      setPaneTitle: vi.fn(),
    };

    const loadConfig = vi.fn(() => config);
    vi.doMock('./config.js', () => ({
      resolvePaths: () => paths,
      loadConfig,
    }));
    vi.doMock('./ui.js', () => ({
      createUI: () => ({
        info: vi.fn(),
        success: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        table: vi.fn(),
        json: vi.fn(),
      }),
    }));
    const createTmux = vi.fn(() => tmux);
    vi.doMock('./tmux.js', () => ({ createTmux }));

    const { createContext } = await import('./context.js');
    const ctx = createContext({
      argv: [],
      flags: { json: false, verbose: false },
      capability: 'storage',
    });

    expect(ctx.config).toEqual(config);
    expect(loadConfig).toHaveBeenCalledWith(paths);
    expect(createTmux).not.toHaveBeenCalled();
  });

  it('ctx.exit calls process.exit', async () => {
    vi.resetModules();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit(${code})`);
    }) as any);

    const { createContext } = await import('./context.js');
    const ctx = createContext({ argv: [], flags: { json: false, verbose: false } });
    expect(() => ctx.exit(2)).toThrow('exit(2)');
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it('uses injected output and exit ownership without terminating the process', async () => {
    vi.resetModules();
    const ui: UI = {
      info: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      table: vi.fn(),
      json: vi.fn(),
    };
    const injectedExit = vi.fn((code: number): never => {
      throw new Error(`injected exit(${code})`);
    });
    const { createContext } = await import('./context.js');
    const ctx = createContext({
      argv: [],
      flags: { json: false, verbose: false },
      capability: 'none',
      ui,
      exit: injectedExit,
    });

    expect(ctx.ui).toBe(ui);
    expect(() => ctx.exit(7)).toThrow('injected exit(7)');
    expect(injectedExit).toHaveBeenCalledWith(7);
  });

  it('does not construct tmux for a no-resource capability', async () => {
    vi.resetModules();
    const createTmux = vi.fn(() => {
      throw new Error('tmux must remain lazy');
    });
    vi.doMock('./tmux.js', () => ({ createTmux }));
    const { createContext } = await import('./context.js');
    const ctx = createContext({
      argv: [],
      flags: { json: false, verbose: false },
      capability: 'none',
    });
    expect(createTmux).not.toHaveBeenCalled();
    expect(ctx.paths.globalConfig).toBeTypeOf('string');
  });

  it('lazily wires the preamble service to the shared identity repository', async () => {
    vi.resetModules();
    const repository = { close: vi.fn() };
    const openIdentityRepository = vi.fn(() => repository);
    const preambleService = { show: vi.fn(), set: vi.fn(), clear: vi.fn(), list: vi.fn() };
    const createPreambleService = vi.fn(() => preambleService);
    vi.doMock('./storage/identity-repository.js', () => ({ openIdentityRepository }));
    vi.doMock('./preamble-service.js', () => ({ createPreambleService }));

    const { createContext } = await import('./context.js');
    const ctx = createContext({
      argv: [],
      flags: { json: false, verbose: false },
      capability: 'storage',
    });
    expect(createPreambleService).not.toHaveBeenCalled();
    expect(ctx.preambleService).toBe(preambleService);
    expect(createPreambleService).toHaveBeenCalledWith({ repository });
    expect(openIdentityRepository).toHaveBeenCalledOnce();
    ctx.dispose?.();
    expect(repository.close).toHaveBeenCalledOnce();
  });

  it('lazily wires request state to the same repository and lifecycle', async () => {
    vi.resetModules();
    const repository = { close: vi.fn() };
    const openIdentityRepository = vi.fn(() => repository);
    const requestService = {
      prepare: vi.fn(),
      beginSend: vi.fn(),
      settle: vi.fn(),
      releaseWait: vi.fn(),
      cleanup: vi.fn(),
      getAttempt: vi.fn(),
      listAttempts: vi.fn(),
    };
    const createRequestService = vi.fn(() => requestService);
    vi.doMock('./storage/identity-repository.js', () => ({ openIdentityRepository }));
    vi.doMock('./request-service.js', () => ({ createRequestService }));

    const { createContext } = await import('./context.js');
    const ctx = createContext({
      argv: [],
      flags: { json: false, verbose: false },
      capability: 'storage',
    });

    expect(createRequestService).not.toHaveBeenCalled();
    expect(ctx.requestService).toBe(requestService);
    expect(createRequestService).toHaveBeenCalledWith({ repository });
    expect(openIdentityRepository).toHaveBeenCalledOnce();
    ctx.dispose?.();
    expect(repository.close).toHaveBeenCalledOnce();
    expect(() => ctx.requestService).toThrow('Context is disposed.');
    expect(createRequestService).toHaveBeenCalledOnce();
  });

  it('closes storage when request service construction fails', async () => {
    vi.resetModules();
    const repository = { close: vi.fn() };
    const openIdentityRepository = vi.fn(() => repository);
    vi.doMock('./storage/identity-repository.js', () => ({ openIdentityRepository }));
    vi.doMock('./request-service.js', () => ({
      createRequestService: vi.fn(() => {
        throw new Error('request service construction failed');
      }),
    }));

    const { createContext } = await import('./context.js');
    const ctx = createContext({
      argv: [],
      flags: { json: false, verbose: false },
      capability: 'storage',
    });
    expect(() => ctx.requestService).toThrow('request service construction failed');
    ctx.dispose?.();
    expect(openIdentityRepository).toHaveBeenCalledOnce();
    expect(repository.close).toHaveBeenCalledOnce();
  });

  it('disposes the shared repository without eagerly opening it', async () => {
    vi.resetModules();
    const repository = { close: vi.fn() };
    const createTmux = vi.fn(() => ({}));
    vi.doMock('./tmux.js', () => ({ createTmux }));
    vi.doMock('./identity-service.js', () => ({
      createIdentityService: vi.fn(() => ({})),
    }));
    vi.doMock('./storage/identity-repository.js', () => ({
      openIdentityRepository: vi.fn(() => repository),
    }));
    const { createContext } = await import('./context.js');
    const ctx = createContext({
      argv: [],
      flags: { json: false, verbose: false },
      capability: 'none',
    });
    expect(createTmux).not.toHaveBeenCalled();
    const service = ctx.identityService;
    expect(createTmux).toHaveBeenCalledOnce();
    ctx.dispose?.();
    expect(repository.close).toHaveBeenCalledOnce();
    expect(service).toBeDefined();
  });

  it('disposes the shared repository before an explicit process exit', async () => {
    vi.resetModules();
    const repository = { close: vi.fn() };
    vi.doMock('./tmux.js', () => ({ createTmux: () => ({}) }));
    vi.doMock('./identity-service.js', () => ({
      createIdentityService: vi.fn(() => ({})),
    }));
    vi.doMock('./storage/identity-repository.js', () => ({
      openIdentityRepository: vi.fn(() => repository),
    }));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit(${code})`);
    }) as never);
    const { createContext } = await import('./context.js');
    const ctx = createContext({
      argv: [],
      flags: { json: false, verbose: false },
      capability: 'none',
    });

    expect(ctx.identityService).toBeDefined();
    expect(() => ctx.exit(5)).toThrow('exit(5)');
    expect(repository.close).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(5);
  });

  it('serves explicit offline roles and rejects missing caller context', async () => {
    vi.resetModules();
    vi.stubEnv('TMUX_PANE', '');
    const createTmux = vi.fn(() => ({ getCurrentPaneId: vi.fn(() => null) }));
    vi.doMock('./tmux.js', () => ({ createTmux }));
    const identity = { id: 'id', name: 'Alice', canonicalName: 'alice' };
    const repository = {
      findByCanonicalName: vi.fn(() => identity),
      findRole: vi.fn(() => undefined),
      close: vi.fn(),
    };
    const openIdentityRepository = vi.fn(() => repository);
    vi.doMock('./storage/identity-repository.js', () => ({ openIdentityRepository }));
    const { createContext } = await import('./context.js');
    const ctx = createContext({
      argv: [],
      flags: { json: true, verbose: false },
      capability: 'storage',
    });
    expect(ctx.roleService!.show({ value: 'Alice', kind: 'identity', explicit: true })).toEqual({
      identity,
      role: null,
    });
    expect(createTmux).not.toHaveBeenCalled();
    expect(() => ctx.roleService!.show()).toThrowError(
      expect.objectContaining({ code: 'IDENTITY_REQUIRED' })
    );
    expect(createTmux).toHaveBeenCalledOnce();
    expect(openIdentityRepository).toHaveBeenCalledOnce();
    ctx.dispose!();
    ctx.dispose!();
    expect(repository.close).toHaveBeenCalledOnce();
  });

  it('does not open storage for an implicit role without validated caller evidence', async () => {
    vi.resetModules();
    vi.stubEnv('TMUX', '/tmp/tmux.sock,321,0');
    vi.stubEnv('TMUX_PANE', '%9');
    const openIdentityRepository = vi.fn(() => {
      throw new Error('storage must remain unopened');
    });
    const createIdentityService = vi.fn(() => {
      throw new Error('identity service must remain unopened');
    });
    const createTmux = vi.fn(() => ({ getCurrentPaneId: vi.fn(() => null) }));
    vi.doMock('./storage/identity-repository.js', () => ({ openIdentityRepository }));
    vi.doMock('./identity-service.js', () => ({ createIdentityService }));
    vi.doMock('./tmux.js', () => ({ createTmux }));
    const { createContext } = await import('./context.js');
    const ctx = createContext({
      argv: [],
      flags: { json: true, verbose: false },
      capability: 'storage',
    });

    expect(() => ctx.roleService!.show()).toThrowError(
      expect.objectContaining({ code: 'IDENTITY_REQUIRED' })
    );
    expect(openIdentityRepository).not.toHaveBeenCalled();
    expect(createIdentityService).not.toHaveBeenCalled();
    expect(createTmux).toHaveBeenCalledOnce();
    ctx.dispose!();
  });

  it('shares one repository between services and closes it exactly once', async () => {
    vi.resetModules();
    const createPreambleService = vi.fn(() => ({ list: vi.fn(() => []) }));
    vi.doMock('./preamble-service.js', () => ({ createPreambleService }));
    vi.stubEnv('TMUX_PANE', '%1');
    const repository = {
      findRole: vi.fn(() => undefined),
      close: vi.fn(() => {
        throw new Error('repository cleanup failed');
      }),
    };
    const openIdentityRepository = vi.fn(() => repository);
    vi.doMock('./storage/identity-repository.js', () => ({ openIdentityRepository }));
    const identity = { id: 'id', name: 'Alice', canonicalName: 'alice' };
    const service = {
      currentIdentity: vi.fn(() => ({ identity })),
    };
    const createIdentityService = vi.fn(() => service);
    vi.doMock('./identity-service.js', () => ({ createIdentityService }));
    vi.doMock('./tmux.js', () => ({
      createTmux: vi.fn(() => ({ getCurrentPaneId: vi.fn(() => '%1') })),
    }));
    const { createContext } = await import('./context.js');
    const ctx = createContext({
      argv: [],
      flags: { json: true, verbose: false },
      capability: 'storage',
    });
    expect(ctx.roleService!.show()).toEqual({ identity, role: null });
    expect(ctx.preambleService).toBeDefined();
    expect(createPreambleService).toHaveBeenCalledWith({ repository });
    expect(ctx.identityService).toBe(service);
    expect(createIdentityService).toHaveBeenCalledWith(expect.objectContaining({ repository }));
    expect(openIdentityRepository).toHaveBeenCalledOnce();
    expect(() => ctx.dispose!()).toThrow('repository cleanup failed');
    expect(repository.close).toHaveBeenCalledOnce();
    expect(() => ctx.dispose!()).not.toThrow();
    expect(repository.close).toHaveBeenCalledOnce();
  });

  it('does not reopen resources after disposal', async () => {
    vi.resetModules();
    const identity = { id: 'id', name: 'Alice', canonicalName: 'alice' };
    const repository = {
      findByCanonicalName: vi.fn(() => identity),
      findRole: vi.fn(() => undefined),
      close: vi.fn(),
    };
    const openIdentityRepository = vi.fn(() => repository);
    vi.doMock('./storage/identity-repository.js', () => ({ openIdentityRepository }));
    vi.doMock('./tmux.js', () => ({
      createTmux: vi.fn(() => ({ getCurrentPaneId: vi.fn(() => null) })),
    }));
    const { createContext } = await import('./context.js');
    const ctx = createContext({
      argv: [],
      flags: { json: false, verbose: false },
      capability: 'storage',
    });
    const role = ctx.roleService!;
    expect(role.show({ value: 'Alice', kind: 'identity', explicit: true })).toEqual({
      identity,
      role: null,
    });
    expect(openIdentityRepository).toHaveBeenCalledOnce();
    ctx.dispose!();
    expect(() => role.show({ value: 'Alice', kind: 'identity', explicit: true })).toThrow(
      'Context is disposed.'
    );
    expect(() => ctx.identityService).toThrow('Context is disposed.');
    expect(openIdentityRepository).toHaveBeenCalledOnce();
    expect(repository.close).toHaveBeenCalledOnce();
  });

  it('closes storage if identity service construction fails', async () => {
    vi.resetModules();
    const repository = { close: vi.fn() };
    const openIdentityRepository = vi.fn(() => repository);
    vi.doMock('./storage/identity-repository.js', () => ({ openIdentityRepository }));
    vi.doMock('./identity-service.js', () => ({
      createIdentityService: vi.fn(() => {
        throw new Error('service construction failed');
      }),
    }));
    vi.doMock('./tmux.js', () => ({ createTmux: vi.fn(() => ({})) }));
    const { createContext } = await import('./context.js');
    const ctx = createContext({
      argv: [],
      flags: { json: false, verbose: false },
      capability: 'none',
    });
    expect(() => ctx.identityService).toThrow('service construction failed');
    ctx.dispose!();
    expect(repository.close).toHaveBeenCalledOnce();
  });
});
