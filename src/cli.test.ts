import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from './types.js';

const unusedRequestService: Context['requestService'] = {
  prepare() {
    throw new Error('Unexpected request service access.');
  },
  beginSend() {
    throw new Error('Unexpected request service access.');
  },
  settle() {
    throw new Error('Unexpected request service access.');
  },
  releaseWait() {
    throw new Error('Unexpected request service access.');
  },
  cleanup() {
    throw new Error('Unexpected request service access.');
  },
  getAttempt() {
    throw new Error('Unexpected request service access.');
  },
  listAttempts() {
    throw new Error('Unexpected request service access.');
  },
};

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
      defaults: {
        timeout: 180,
        pollInterval: 1,
        captureLines: 100,
        maxCaptureLines: 2000,
        preambleEvery: 3,
        pasteEnterDelayMs: 500,
      },
    },
    tmux: {
      send: vi.fn(),
      capture: vi.fn(),
      listPanes: vi.fn(() => []),
      getCurrentPaneId: vi.fn(() => null),
      resolvePaneTarget: vi.fn((target: string) => target),
      setPaneTitle: vi.fn(),
    },
    identityService: {
      bindCurrent: vi.fn(),
      bindPane: vi.fn(),
      unbindCurrent: vi.fn(),
      currentIdentity: vi.fn(),
      activeIdentities: vi.fn(() => []),
      resolveActive: vi.fn(),
      reconcile: vi.fn(),
    },
    requestService: unusedRequestService,
    paths: {
      globalDir: '/g',
      globalConfig: '/g/c.json',
      localConfig: '/p/t.json',
      stateFile: '/g/s.json',
      databaseFile: '/g/tmux-team.db',
    },
    exit: ((code: number) => {
      const err = new Error(`exit(${code})`);
      (err as Error & { exitCode: number }).exitCode = code;
      throw err;
    }) as any,
  };
}

describe('cli', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['team', ['node', 'cli', 'team']],
    ['--team value', ['node', 'cli', 'list', '--team', 'legacy']],
    ['--team=value', ['node', 'cli', 'list', '--team=legacy']],
  ])('rejects %s before creating command context', async (_label, argv) => {
    vi.resetModules();
    const createContext = vi.fn(() => makeStubContext());
    vi.doMock('./context.js', () => ({
      createContext,
      ExitCodes: { SUCCESS: 0, ERROR: 1, UNSUPPORTED_TEAM: 1 },
    }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(argv.slice(2))).toBe(1);
    expect(createContext).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      '✗ Team-scoped commands and --team are not supported in tmt v5.'
    );
  });

  it('prints completion for bash', async () => {
    vi.resetModules();

    vi.doMock('./context.js', () => ({
      createContext: () => makeStubContext(),
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/completion.js', () => ({
      cmdCompletion: (shell?: string) => {
        console.log(`completion:${shell}`);
      },
    }));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(['completion', 'bash'])).toBe(0);
    expect(logSpy).toHaveBeenCalledWith('completion:bash');
  });

  it('errors on invalid time format', async () => {
    vi.resetModules();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(['talk', 'codex', 'hi', '--delay', 'abc'])).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      '✗ Invalid time format: abc. Use number (seconds) or number with ms/s suffix.'
    );
  });

  it('reports an unknown command without creating a Context', async () => {
    vi.resetModules();
    const createContext = vi.fn(() => makeStubContext());
    vi.doMock('./context.js', () => ({
      createContext,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(['nope'])).toBe(1);
    expect(createContext).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown command'));
  });

  it('handles --version by printing VERSION', async () => {
    vi.resetModules();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(['--version'])).toBe(0);
    expect(logSpy).toHaveBeenCalled();
  });

  it('routes learn command and does not exit', async () => {
    vi.resetModules();

    const ctx = makeStubContext();
    const learnSpy = vi.fn();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/learn.js', () => ({ cmdLearn: learnSpy }));
    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(['learn'])).toBe(0);
    expect(learnSpy).toHaveBeenCalled();
  });

  it('prints JSON error when --json and a command throws', async () => {
    vi.resetModules();
    // The mocked command throws through the shared runner boundary.

    const ctx = makeStubContext();
    ctx.flags.json = true;
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/role.js', () => ({
      cmdRole: () => {
        throw new Error('boom');
      },
    }));

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(['role', 'show', '--json'])).toBe(1);
    expect(JSON.parse(String(writeSpy.mock.calls[0]?.[0]))).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'boom' },
    });
  });

  it('routes install command', async () => {
    vi.resetModules();

    const ctx = makeStubContext();
    const installSpy = vi.fn();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/install.js', () => ({ cmdInstall: installSpy }));
    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(['install', 'claude'])).toBe(0);

    expect(installSpy).toHaveBeenCalledWith(ctx, 'claude');
  });

  it('routes preamble command', async () => {
    vi.resetModules();

    const ctx = makeStubContext();
    const preambleSpy = vi.fn();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/preamble.js', () => ({ cmdPreamble: preambleSpy }));
    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(['preamble', 'show'])).toBe(0);

    expect(preambleSpy).toHaveBeenCalledWith(ctx, {
      kind: 'preamble',
      operation: 'show',
      agent: undefined,
    });
  });

  it('routes this command', async () => {
    vi.resetModules();

    const ctx = makeStubContext();
    const thisSpy = vi.fn();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/this.js', () => ({ cmdThis: thisSpy }));
    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(['this', 'myagent'])).toBe(0);

    expect(thisSpy).toHaveBeenCalledWith(ctx, 'myagent');
  });

  it('routes name command as a current-pane identity binding', async () => {
    vi.resetModules();

    const ctx = makeStubContext();
    const nameSpy = vi.fn();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/name.js', () => ({ cmdName: nameSpy }));
    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(['name', 'backend'])).toBe(0);

    expect(nameSpy).toHaveBeenCalledWith(ctx, 'backend');
  });

  it('errors when name command has missing or extra arguments', async () => {
    vi.resetModules();
    const argv = ['name', 'backend', 'main:1.2', 'extra'];

    const ctx = makeStubContext();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/name.js', () => ({ cmdName: vi.fn() }));

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(argv)).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith('✗ Usage: tmux-team name <global-name>');
  });

  it('errors when name command has no name', async () => {
    vi.resetModules();
    const argv = ['name'];
    const ctx = makeStubContext();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/name.js', () => ({ cmdName: vi.fn() }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(argv)).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith('✗ Usage: tmux-team name <global-name>');
  });

  it('errors when this command is missing name', async () => {
    vi.resetModules();
    const argv = ['this'];

    const ctx = makeStubContext();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/this.js', () => ({ cmdThis: vi.fn() }));

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(argv)).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith('✗ Usage: tmux-team this <global-name>');
  });

  it('errors when this command has an extra argument', async () => {
    vi.resetModules();
    const argv = ['this', 'backend', 'extra'];
    const ctx = makeStubContext();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/this.js', () => ({ cmdThis: vi.fn() }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(argv)).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith('✗ Usage: tmux-team this <global-name>');
  });

  it('routes whoami without arguments', async () => {
    vi.resetModules();
    const ctx = makeStubContext();
    const whoamiSpy = vi.fn();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/whoami.js', () => ({ cmdWhoami: whoamiSpy }));
    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(['whoami'])).toBe(0);
    expect(whoamiSpy).toHaveBeenCalledWith(ctx);
  });

  it('routes unbind without arguments', async () => {
    vi.resetModules();
    const ctx = makeStubContext();
    const unbindSpy = vi.fn();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/unbind.js', () => ({ cmdUnbind: unbindSpy }));
    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(['unbind'])).toBe(0);
    expect(unbindSpy).toHaveBeenCalledWith(ctx);
  });

  it.each(['whoami', 'unbind'])('rejects arguments for %s', async (command) => {
    vi.resetModules();
    const argv = [command, 'extra'];
    const ctx = makeStubContext();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock(`./commands/${command}.js`, () => ({
      [command === 'whoami' ? 'cmdWhoami' : 'cmdUnbind']: vi.fn(),
    }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(argv)).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(`✗ Usage: tmux-team ${command}`);
  });

  it('routes init command', async () => {
    vi.resetModules();

    const ctx = makeStubContext();
    const initSpy = vi.fn();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/init.js', () => ({ cmdInit: initSpy }));
    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(['init'])).toBe(0);

    expect(initSpy).toHaveBeenCalledWith(ctx);
  });

  it('routes list command', async () => {
    vi.resetModules();

    const ctx = makeStubContext();
    const listSpy = vi.fn();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/list.js', () => ({ cmdList: listSpy }));
    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(['list'])).toBe(0);

    expect(listSpy).toHaveBeenCalledWith(ctx);
  });

  it('routes ls alias to list command', async () => {
    vi.resetModules();

    const ctx = makeStubContext();
    const listSpy = vi.fn();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/list.js', () => ({ cmdList: listSpy }));
    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(['ls'])).toBe(0);

    expect(listSpy).toHaveBeenCalledWith(ctx);
  });

  it('routes add command', async () => {
    vi.resetModules();

    const ctx = makeStubContext();
    const addSpy = vi.fn();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/add.js', () => ({ cmdAdd: addSpy }));
    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(['add', '1.0', 'myagent'])).toBe(0);

    expect(addSpy).toHaveBeenCalledWith(ctx, '1.0', 'myagent');
  });

  it.each([
    ['missing', ['node', 'cli', 'add', '1.0']],
    ['extra', ['node', 'cli', 'add', '1.0', 'backend', 'remark']],
  ])('rejects add command with %s arguments', async (_case, argv) => {
    vi.resetModules();
    const commandArgs = argv.slice(2);
    const ctx = makeStubContext();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/add.js', () => ({ cmdAdd: vi.fn() }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(commandArgs)).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith('✗ Usage: tmux-team add <pane-target> <global-name>');
  });

  it('routes config command', async () => {
    vi.resetModules();

    const ctx = makeStubContext();
    const configSpy = vi.fn();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/config.js', () => ({ cmdConfig: configSpy }));
    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(['config', 'show'])).toBe(0);

    expect(configSpy).toHaveBeenCalledWith(ctx, {
      kind: 'config',
      operation: 'show',
      global: false,
    });
  });

  it('parses --timeout flag with seconds', async () => {
    vi.resetModules();

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
    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(['talk', 'claude', 'hi', '--timeout', '30'])).toBe(0);

    expect(ctx.flags.timeout).toBe(30);
  });

  it('parses --timeout flag with ms suffix', async () => {
    vi.resetModules();

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
    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(['talk', 'claude', 'hi', '--timeout', '500ms'])).toBe(0);

    expect(ctx.flags.timeout).toBe(0.5);
  });

  it('parses --lines flag', async () => {
    vi.resetModules();

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
    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(['talk', 'claude', 'hi', '--wait', '--lines', '50'])).toBe(0);

    expect(ctx.flags.lines).toBe(50);
  });

  it('parses --no-preamble flag', async () => {
    vi.resetModules();

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
    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(['talk', 'claude', 'hi', '--no-preamble'])).toBe(0);

    expect(ctx.flags.noPreamble).toBe(true);
  });

  it('routes check command with lines argument', async () => {
    vi.resetModules();

    const ctx = makeStubContext();
    const checkSpy = vi.fn();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    vi.doMock('./commands/check.js', () => ({ cmdCheck: checkSpy }));
    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(['check', 'claude', '50'])).toBe(0);

    expect(checkSpy).toHaveBeenCalledWith(ctx, 'claude', 50);
  });

  it('errors on talk with missing arguments', async () => {
    vi.resetModules();
    const argv = ['talk', 'claude']; // missing message

    const ctx = makeStubContext();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(argv)).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('errors on add with missing arguments', async () => {
    vi.resetModules();
    const argv = ['add', 'claude']; // missing pane

    const ctx = makeStubContext();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(argv)).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('errors on check with missing arguments', async () => {
    vi.resetModules();
    const argv = ['check']; // missing target

    const ctx = makeStubContext();
    vi.doMock('./context.js', () => ({
      createContext: () => ctx,
      ExitCodes: { SUCCESS: 0, ERROR: 1 },
    }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runCli } = await import('./cli-runner.js');
    expect(await runCli(argv)).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  });
});
