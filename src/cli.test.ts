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
      defaults: { timeout: 180, pollInterval: 1, captureLines: 100, maxCaptureLines: 2000, preambleEvery: 3 },
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

  it('routes install command', async () => {
    vi.resetModules();
    process.argv = ['node', 'cli', 'install', 'claude'];

    const ctx = makeStubContext();
    const installSpy = vi.fn();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/install.js', () => ({ cmdInstall: installSpy }));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    await import('./cli.js');
    // allow async to resolve
    await new Promise((r) => setTimeout(r, 0));

    expect(installSpy).toHaveBeenCalledWith(ctx, 'claude');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('routes preamble command', async () => {
    vi.resetModules();
    process.argv = ['node', 'cli', 'preamble', 'show'];

    const ctx = makeStubContext();
    const preambleSpy = vi.fn();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/preamble.js', () => ({ cmdPreamble: preambleSpy }));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    await import('./cli.js');
    await new Promise((r) => setTimeout(r, 0));

    expect(preambleSpy).toHaveBeenCalledWith(ctx, ['show']);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('routes this command', async () => {
    vi.resetModules();
    process.argv = ['node', 'cli', 'this', 'myagent', 'remark'];

    const ctx = makeStubContext();
    const thisSpy = vi.fn();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/this.js', () => ({ cmdThis: thisSpy }));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    await import('./cli.js');
    await new Promise((r) => setTimeout(r, 0));

    expect(thisSpy).toHaveBeenCalledWith(ctx, 'myagent', 'remark');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('errors when this command is missing name', async () => {
    vi.resetModules();
    process.argv = ['node', 'cli', 'this'];

    const ctx = makeStubContext();
    const exitSpy = vi.fn();
    ctx.exit = exitSpy as any;
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/this.js', () => ({ cmdThis: vi.fn() }));

    await import('./cli.js');
    await new Promise((r) => setTimeout(r, 0));

    expect(ctx.ui.error).toHaveBeenCalledWith('Usage: tmux-team this <name> [remark]');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('routes update command with --pane and --remark flags', async () => {
    vi.resetModules();
    process.argv = ['node', 'cli', 'update', 'codex', '--pane', '2.0', '--remark', 'updated'];

    const ctx = makeStubContext();
    const updateSpy = vi.fn();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/update.js', () => ({ cmdUpdate: updateSpy }));

    await import('./cli.js');
    await new Promise((r) => setTimeout(r, 0));

    expect(updateSpy).toHaveBeenCalledWith(ctx, 'codex', { pane: '2.0', remark: 'updated' });
  });

  it('routes init command', async () => {
    vi.resetModules();
    process.argv = ['node', 'cli', 'init'];

    const ctx = makeStubContext();
    const initSpy = vi.fn();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/init.js', () => ({ cmdInit: initSpy }));

    await import('./cli.js');
    await new Promise((r) => setTimeout(r, 0));

    expect(initSpy).toHaveBeenCalledWith(ctx);
  });

  it('routes list command', async () => {
    vi.resetModules();
    process.argv = ['node', 'cli', 'list'];

    const ctx = makeStubContext();
    const listSpy = vi.fn();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/list.js', () => ({ cmdList: listSpy }));

    await import('./cli.js');
    await new Promise((r) => setTimeout(r, 0));

    expect(listSpy).toHaveBeenCalledWith(ctx);
  });

  it('routes ls alias to list command', async () => {
    vi.resetModules();
    process.argv = ['node', 'cli', 'ls'];

    const ctx = makeStubContext();
    const listSpy = vi.fn();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/list.js', () => ({ cmdList: listSpy }));

    await import('./cli.js');
    await new Promise((r) => setTimeout(r, 0));

    expect(listSpy).toHaveBeenCalledWith(ctx);
  });

  it('routes add command', async () => {
    vi.resetModules();
    process.argv = ['node', 'cli', 'add', 'myagent', '1.0', 'remark'];

    const ctx = makeStubContext();
    const addSpy = vi.fn();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/add.js', () => ({ cmdAdd: addSpy }));

    await import('./cli.js');
    await new Promise((r) => setTimeout(r, 0));

    expect(addSpy).toHaveBeenCalledWith(ctx, 'myagent', '1.0', 'remark');
  });

  it('routes config command', async () => {
    vi.resetModules();
    process.argv = ['node', 'cli', 'config', 'get', 'mode'];

    const ctx = makeStubContext();
    const configSpy = vi.fn();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/config.js', () => ({ cmdConfig: configSpy }));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    await import('./cli.js');
    await new Promise((r) => setTimeout(r, 0));

    expect(configSpy).toHaveBeenCalledWith(ctx, ['get', 'mode']);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('parses --timeout flag with seconds', async () => {
    vi.resetModules();
    process.argv = ['node', 'cli', 'talk', 'claude', 'hi', '--timeout', '30'];

    const ctx = makeStubContext();
    const talkSpy = vi.fn();
    vi.doMock('./context.js', () => ({
      createContext: (opts: any) => {
        ctx.flags = opts.flags;
        return ctx;
      },
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/talk.js', () => ({ cmdTalk: talkSpy }));
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    await import('./cli.js');
    await new Promise((r) => setTimeout(r, 0));

    expect(ctx.flags.timeout).toBe(30);
  });

  it('parses --timeout flag with ms suffix', async () => {
    vi.resetModules();
    process.argv = ['node', 'cli', 'talk', 'claude', 'hi', '--timeout', '500ms'];

    const ctx = makeStubContext();
    const talkSpy = vi.fn();
    vi.doMock('./context.js', () => ({
      createContext: (opts: any) => {
        ctx.flags = opts.flags;
        return ctx;
      },
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/talk.js', () => ({ cmdTalk: talkSpy }));
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    await import('./cli.js');
    await new Promise((r) => setTimeout(r, 0));

    expect(ctx.flags.timeout).toBe(0.5);
  });

  it('parses --lines flag', async () => {
    vi.resetModules();
    process.argv = ['node', 'cli', 'talk', 'claude', 'hi', '--wait', '--lines', '50'];

    const ctx = makeStubContext();
    const talkSpy = vi.fn();
    vi.doMock('./context.js', () => ({
      createContext: (opts: any) => {
        ctx.flags = opts.flags;
        return ctx;
      },
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/talk.js', () => ({ cmdTalk: talkSpy }));
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    await import('./cli.js');
    await new Promise((r) => setTimeout(r, 0));

    expect(ctx.flags.lines).toBe(50);
  });

  it('parses --no-preamble flag', async () => {
    vi.resetModules();
    process.argv = ['node', 'cli', 'talk', 'claude', 'hi', '--no-preamble'];

    const ctx = makeStubContext();
    const talkSpy = vi.fn();
    vi.doMock('./context.js', () => ({
      createContext: (opts: any) => {
        ctx.flags = opts.flags;
        return ctx;
      },
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/talk.js', () => ({ cmdTalk: talkSpy }));
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    await import('./cli.js');
    await new Promise((r) => setTimeout(r, 0));

    expect(ctx.flags.noPreamble).toBe(true);
  });

  it('routes check command with lines argument', async () => {
    vi.resetModules();
    process.argv = ['node', 'cli', 'check', 'claude', '50'];

    const ctx = makeStubContext();
    const checkSpy = vi.fn();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/check.js', () => ({ cmdCheck: checkSpy }));
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    await import('./cli.js');
    await new Promise((r) => setTimeout(r, 0));

    expect(checkSpy).toHaveBeenCalledWith(ctx, 'claude', 50);
  });

  it('routes update command with --pane= syntax', async () => {
    vi.resetModules();
    process.argv = ['node', 'cli', 'update', 'claude', '--pane=2.0'];

    const ctx = makeStubContext();
    const updateSpy = vi.fn();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/update.js', () => ({ cmdUpdate: updateSpy }));
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    await import('./cli.js');
    await new Promise((r) => setTimeout(r, 0));

    expect(updateSpy).toHaveBeenCalledWith(ctx, 'claude', { pane: '2.0' });
  });

  it('routes update command with --remark= syntax', async () => {
    vi.resetModules();
    process.argv = ['node', 'cli', 'update', 'claude', '--remark=new remark'];

    const ctx = makeStubContext();
    const updateSpy = vi.fn();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/update.js', () => ({ cmdUpdate: updateSpy }));
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    await import('./cli.js');
    await new Promise((r) => setTimeout(r, 0));

    expect(updateSpy).toHaveBeenCalledWith(ctx, 'claude', { remark: 'new remark' });
  });

  it('errors on talk with missing arguments', async () => {
    vi.resetModules();
    process.argv = ['node', 'cli', 'talk', 'claude']; // missing message

    const ctx = makeStubContext();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    await import('./cli.js');
    await new Promise((r) => setTimeout(r, 0));

    expect(ctx.ui.error).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('errors on add with missing arguments', async () => {
    vi.resetModules();
    process.argv = ['node', 'cli', 'add', 'claude']; // missing pane

    const ctx = makeStubContext();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    await import('./cli.js');
    await new Promise((r) => setTimeout(r, 0));

    expect(ctx.ui.error).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('errors on update with missing arguments', async () => {
    vi.resetModules();
    process.argv = ['node', 'cli', 'update']; // missing name

    const ctx = makeStubContext();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    await import('./cli.js');
    await new Promise((r) => setTimeout(r, 0));

    expect(ctx.ui.error).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('errors on remove with missing arguments', async () => {
    vi.resetModules();
    process.argv = ['node', 'cli', 'remove']; // missing name

    const ctx = makeStubContext();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    await import('./cli.js');
    await new Promise((r) => setTimeout(r, 0));

    expect(ctx.ui.error).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('errors on check with missing arguments', async () => {
    vi.resetModules();
    process.argv = ['node', 'cli', 'check']; // missing target

    const ctx = makeStubContext();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    await import('./cli.js');
    await new Promise((r) => setTimeout(r, 0));

    expect(ctx.ui.error).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
