import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from './types.js';

function makeStubContext(): Context {
  return {
    argv: [],
    flags: { json: false, verbose: false },
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
      defaults: { timeout: 180, pollInterval: 1, captureLines: 100, preambleEvery: 3 },
      agents: {},
      paneRegistry: {},
    },
    tmux: {
      send: vi.fn(),
      capture: vi.fn(),
      listPanes: vi.fn(() => []),
      getCurrentPaneId: vi.fn(() => null),
    },
    paths: {
      globalDir: '/g',
      globalConfig: '/g/c.json',
      localConfig: '/p/t.json',
      stateFile: '/g/s.json',
    },
    exit: ((code: number) => {
      const err = new Error(`exit(${code})`);
      (err as Error & { exitCode: number }).exitCode = code;
      throw err;
    }) as any,
  };
}

describe('cli', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it('prints completion for bash', async () => {
    vi.resetModules();
    process.argv = ['node', 'cli', 'completion', 'bash'];

    vi.doMock('./context.js', () => ({
      createContext: () => makeStubContext(),
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/completion.js', () => ({
      cmdCompletion: (shell?: string) => {
        console.log(`completion:${shell}`);
      },
    }));

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await import('./cli.js');
    expect(logSpy).toHaveBeenCalledWith('completion:bash');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('errors on invalid time format', async () => {
    vi.resetModules();
    process.argv = ['node', 'cli', 'talk', 'codex', 'hi', '--delay', 'abc'];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit(${code})`);
    }) as any);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(import('./cli.js')).rejects.toThrow('exit(1)');
    expect(errSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('routes unknown command to ctx.ui.error and exits', async () => {
    vi.resetModules();
    process.argv = ['node', 'cli', 'nope'];

    const ctx = makeStubContext();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);
    await import('./cli.js');
    expect(ctx.ui.error).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('handles --version by printing VERSION', async () => {
    vi.resetModules();
    process.argv = ['node', 'cli', '--version'];
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    await import('./cli.js');
    // allow the dynamic import to resolve
    await new Promise((r) => setTimeout(r, 0));
    expect(logSpy).toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('routes learn command and does not exit', async () => {
    vi.resetModules();
    process.argv = ['node', 'cli', 'learn'];

    const ctx = makeStubContext();
    const learnSpy = vi.fn();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/learn.js', () => ({ cmdLearn: learnSpy }));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    await import('./cli.js');
    expect(learnSpy).toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('prints JSON error when --json and a command throws', async () => {
    vi.resetModules();
    process.argv = ['node', 'cli', 'remove', 'some-agent', '--json']; // will throw in our mocked cmdRemove

    const ctx = makeStubContext();
    ctx.flags.json = true;
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/remove.js', () => ({
      cmdRemove: () => {
        throw new Error('boom');
      },
    }));

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    await import('./cli.js');
    // allow the run().catch handler to run
    await new Promise((r) => setTimeout(r, 0));

    expect(errSpy).toHaveBeenCalledWith(JSON.stringify({ error: 'boom' }));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
