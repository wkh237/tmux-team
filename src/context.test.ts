import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Paths, ResolvedConfig, UI, Tmux } from './types.js';

describe('createContext', () => {
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
    };
    const config: ResolvedConfig = {
      mode: 'polling',
      preambleMode: 'always',
      defaults: { timeout: 180, pollInterval: 1, captureLines: 100, maxCaptureLines: 2000, preambleEvery: 3, pasteEnterDelayMs: 500 },
      agents: {},
      paneRegistry: {},
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
    };

    vi.doMock('./config.js', () => ({
      resolvePaths: () => paths,
      loadConfig: () => config,
    }));
    vi.doMock('./ui.js', () => ({ createUI: () => ui }));
    vi.doMock('./tmux.js', () => ({ createTmux: () => tmux }));

    const { createContext } = await import('./context.js');
    const ctx = createContext({ argv: ['a'], flags: { json: false, verbose: false }, cwd: '/p' });

    expect(ctx.argv).toEqual(['a']);
    expect(ctx.paths).toEqual(paths);
    expect(ctx.config).toEqual(config);
    expect(ctx.ui).toBe(ui);
    expect(ctx.tmux).toBe(tmux);
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
});
