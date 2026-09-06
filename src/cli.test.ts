import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from './types.js';
import type { CreateContextOptions } from './context.js';
import { createDefaultConfig } from './config-settings.js';

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
  submitResponse() {
    throw new Error('Unexpected request service access.');
  },
  getResponse() {
    throw new Error('Unexpected request service access.');
  },
  getRequestContext() {
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
    config: createDefaultConfig(),
    tmux: {
      send: vi.fn(),
      capture: vi.fn(),
      listPanes: vi.fn(() => []),
      getCurrentPaneId: vi.fn(() => null),
      resolvePaneTarget: vi.fn((target: string) => target),
      setPaneTitle: vi.fn(),
    },
    identityService: {
      createIdentity: vi.fn(() => {
        throw new Error('Unexpected durable identity creation.');
      }),
      showIdentity: vi.fn(() => {
        throw new Error('Unexpected durable identity lookup.');
      }),
      listIdentities: vi.fn(() => {
        throw new Error('Unexpected durable identity listing.');
      }),
      bindCurrent: vi.fn(),
      bindPane: vi.fn(),
      unbindCurrent: vi.fn(),
      currentIdentity: vi.fn(),
      resolveIdentity: vi.fn(),
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

const handlers = {
  cmdHelp: vi.fn(),
  cmdCompletion: vi.fn(),
  cmdLearn: vi.fn(),
  cmdInit: vi.fn(),
  cmdList: vi.fn(),
  cmdAdd: vi.fn(),
  cmdTalk: vi.fn(),
  cmdCheck: vi.fn(),
  cmdConfig: vi.fn(),
  cmdPreamble: vi.fn(),
  cmdInstall: vi.fn(),
  cmdThis: vi.fn(),
  cmdName: vi.fn(),
  cmdUpgrade: vi.fn(),
  cmdWhoami: vi.fn(),
  cmdUnbind: vi.fn(),
  cmdRole: vi.fn(),
  cmdIdentity: vi.fn(),
  cmdReply: vi.fn(),
  cmdResult: vi.fn(),
};

const contextFactory = vi.fn((_options: CreateContextOptions) => makeStubContext());

vi.mock('./context.js', () => ({
  createContext: (options: CreateContextOptions) => contextFactory(options),
  ExitCodes: { SUCCESS: 0, ERROR: 1, UNSUPPORTED_TEAM: 1 },
}));
vi.mock('./commands/help.js', () => ({ cmdHelp: handlers.cmdHelp }));
vi.mock('./commands/completion.js', () => ({ cmdCompletion: handlers.cmdCompletion }));
vi.mock('./commands/learn.js', () => ({ cmdLearn: handlers.cmdLearn }));
vi.mock('./commands/init.js', () => ({ cmdInit: handlers.cmdInit }));
vi.mock('./commands/list.js', () => ({ cmdList: handlers.cmdList }));
vi.mock('./commands/add.js', () => ({ cmdAdd: handlers.cmdAdd }));
vi.mock('./commands/talk.js', () => ({ cmdTalk: handlers.cmdTalk }));
vi.mock('./commands/check.js', () => ({ cmdCheck: handlers.cmdCheck }));
vi.mock('./commands/config.js', () => ({ cmdConfig: handlers.cmdConfig }));
vi.mock('./commands/preamble.js', () => ({ cmdPreamble: handlers.cmdPreamble }));
vi.mock('./commands/install.js', () => ({ cmdInstall: handlers.cmdInstall }));
vi.mock('./commands/this.js', () => ({ cmdThis: handlers.cmdThis }));
vi.mock('./commands/name.js', () => ({ cmdName: handlers.cmdName }));
vi.mock('./commands/upgrade.js', () => ({ cmdUpgrade: handlers.cmdUpgrade }));
vi.mock('./commands/whoami.js', () => ({ cmdWhoami: handlers.cmdWhoami }));
vi.mock('./commands/unbind.js', () => ({ cmdUnbind: handlers.cmdUnbind }));
vi.mock('./commands/role.js', () => ({ cmdRole: handlers.cmdRole }));
vi.mock('./commands/identity.js', () => ({ cmdIdentity: handlers.cmdIdentity }));
vi.mock('./commands/reply.js', () => ({ cmdReply: handlers.cmdReply }));
vi.mock('./commands/result.js', () => ({ cmdResult: handlers.cmdResult }));

const { runCli } = await import('./cli-runner.js');

describe('cli', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    contextFactory.mockImplementation(() => makeStubContext());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['team', ['node', 'cli', 'team']],
    ['--team value', ['node', 'cli', 'list', '--team', 'legacy']],
    ['--team=value', ['node', 'cli', 'list', '--team=legacy']],
  ])('rejects %s before creating command context', async (_label, argv) => {
    const createContext = contextFactory;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runCli(argv.slice(2))).toBe(1);
    expect(createContext).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      '✗ Team-scoped commands and --team are not supported in tmt v5.'
    );
  });

  it('prints completion for bash', async () => {
    handlers.cmdCompletion.mockImplementation((shell?: string) => {
      console.log(`completion:${shell}`);
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await runCli(['completion', 'bash'])).toBe(0);
    expect(logSpy).toHaveBeenCalledWith('completion:bash');
  });

  it('errors on invalid time format', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runCli(['talk', 'codex', 'hi', '--delay', 'abc'])).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      '✗ Invalid time format: abc. Use number (seconds) or number with ms/s suffix.'
    );
  });

  it('reports an unknown command without creating a Context', async () => {
    const createContext = contextFactory;

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runCli(['nope'])).toBe(1);
    expect(createContext).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown command'));
  });

  it('handles --version by printing VERSION', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await runCli(['--version'])).toBe(0);
    expect(logSpy).toHaveBeenCalled();
  });

  it('routes learn command and does not exit', async () => {
    const ctx = makeStubContext();
    const learnSpy = handlers.cmdLearn;
    contextFactory.mockImplementation(() => ctx);
    expect(await runCli(['learn'])).toBe(0);
    expect(learnSpy).toHaveBeenCalled();
  });

  it('prints JSON error when --json and a command throws', async () => {
    // The mocked command throws through the shared runner boundary.

    const ctx = makeStubContext();
    ctx.flags.json = true;
    contextFactory.mockImplementation(() => ctx);
    handlers.cmdRole.mockImplementation(() => {
      throw new Error('boom');
    });

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await runCli(['role', 'show', '--json'])).toBe(1);
    expect(JSON.parse(String(writeSpy.mock.calls[0]?.[0]))).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'boom' },
    });
  });

  it('routes install command', async () => {
    const ctx = makeStubContext();
    const installSpy = handlers.cmdInstall;
    contextFactory.mockImplementation(() => ctx);
    expect(await runCli(['install', 'claude'])).toBe(0);

    expect(installSpy).toHaveBeenCalledWith(ctx, 'claude', undefined);
  });

  it('routes preamble command', async () => {
    const ctx = makeStubContext();
    const preambleSpy = handlers.cmdPreamble;
    contextFactory.mockImplementation(() => ctx);
    expect(await runCli(['preamble', 'show'])).toBe(0);

    expect(preambleSpy).toHaveBeenCalledWith(ctx, {
      kind: 'preamble',
      operation: 'show',
      agent: undefined,
    });
  });

  it('routes this command', async () => {
    const ctx = makeStubContext();
    const thisSpy = handlers.cmdThis;
    contextFactory.mockImplementation(() => ctx);
    expect(await runCli(['this', 'myagent'])).toBe(0);

    expect(thisSpy).toHaveBeenCalledWith(ctx, 'myagent');
  });

  it('routes name command as a current-pane identity binding', async () => {
    const ctx = makeStubContext();
    const nameSpy = handlers.cmdName;
    contextFactory.mockImplementation(() => ctx);
    expect(await runCli(['name', 'backend'])).toBe(0);

    expect(nameSpy).toHaveBeenCalledWith(ctx, 'backend');
  });

  it('errors when name command has missing or extra arguments', async () => {
    const argv = ['name', 'backend', 'main:1.2', 'extra'];

    const ctx = makeStubContext();
    contextFactory.mockImplementation(() => ctx);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runCli(argv)).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith('✗ Usage: tmux-team name <global-name>');
  });

  it('errors when name command has no name', async () => {
    const argv = ['name'];
    const ctx = makeStubContext();
    contextFactory.mockImplementation(() => ctx);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runCli(argv)).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith('✗ Usage: tmux-team name <global-name>');
  });

  it('errors when this command is missing name', async () => {
    const argv = ['this'];

    const ctx = makeStubContext();
    contextFactory.mockImplementation(() => ctx);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runCli(argv)).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith('✗ Usage: tmux-team this <global-name>');
  });

  it('errors when this command has an extra argument', async () => {
    const argv = ['this', 'backend', 'extra'];
    const ctx = makeStubContext();
    contextFactory.mockImplementation(() => ctx);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runCli(argv)).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith('✗ Usage: tmux-team this <global-name>');
  });

  it('routes whoami without arguments', async () => {
    const ctx = makeStubContext();
    const whoamiSpy = handlers.cmdWhoami;
    contextFactory.mockImplementation(() => ctx);
    expect(await runCli(['whoami'])).toBe(0);
    expect(whoamiSpy).toHaveBeenCalledWith(ctx);
  });

  it('routes unbind without arguments', async () => {
    const ctx = makeStubContext();
    const unbindSpy = handlers.cmdUnbind;
    contextFactory.mockImplementation(() => ctx);
    expect(await runCli(['unbind'])).toBe(0);
    expect(unbindSpy).toHaveBeenCalledWith(ctx);
  });

  it.each(['whoami', 'unbind'])('rejects arguments for %s', async (command) => {
    const argv = [command, 'extra'];
    const ctx = makeStubContext();
    contextFactory.mockImplementation(() => ctx);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runCli(argv)).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(`✗ Usage: tmux-team ${command}`);
  });

  it('routes init command', async () => {
    const ctx = makeStubContext();
    const initSpy = handlers.cmdInit;
    contextFactory.mockImplementation(() => ctx);
    expect(await runCli(['init'])).toBe(0);

    expect(initSpy).toHaveBeenCalledWith(ctx);
  });

  it('routes list command', async () => {
    const ctx = makeStubContext();
    const listSpy = handlers.cmdList;
    contextFactory.mockImplementation(() => ctx);
    expect(await runCli(['list'])).toBe(0);

    expect(listSpy).toHaveBeenCalledWith(ctx);
  });

  it('routes ls alias to list command', async () => {
    const ctx = makeStubContext();
    const listSpy = handlers.cmdList;
    contextFactory.mockImplementation(() => ctx);
    expect(await runCli(['ls'])).toBe(0);

    expect(listSpy).toHaveBeenCalledWith(ctx);
  });

  it('routes add command', async () => {
    const ctx = makeStubContext();
    const addSpy = handlers.cmdAdd;
    contextFactory.mockImplementation(() => ctx);
    expect(await runCli(['add', '1.0', 'myagent'])).toBe(0);

    expect(addSpy).toHaveBeenCalledWith(ctx, '1.0', 'myagent');
  });

  it.each([
    ['missing', ['node', 'cli', 'add', '1.0']],
    ['extra', ['node', 'cli', 'add', '1.0', 'backend', 'remark']],
  ])('rejects add command with %s arguments', async (_case, argv) => {
    const commandArgs = argv.slice(2);
    const ctx = makeStubContext();
    contextFactory.mockImplementation(() => ctx);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runCli(commandArgs)).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith('✗ Usage: tmux-team add <pane-target> <global-name>');
  });

  it('routes config command', async () => {
    const ctx = makeStubContext();
    const configSpy = handlers.cmdConfig;
    contextFactory.mockImplementation(() => ctx);
    expect(await runCli(['config', 'show'])).toBe(0);

    expect(configSpy).toHaveBeenCalledWith(ctx, {
      kind: 'config',
      operation: 'show',
      global: false,
    });
  });

  it('parses --timeout flag with seconds', async () => {
    const ctx = makeStubContext();
    const talkSpy = handlers.cmdTalk;
    contextFactory.mockImplementation((opts) => {
      ctx.flags = opts.flags;
      return ctx;
    });
    expect(await runCli(['talk', 'claude', 'hi', '--timeout', '30'])).toBe(0);

    expect(ctx.flags.timeout).toBe(30);
    expect(talkSpy).toHaveBeenCalledOnce();
  });

  it('parses --timeout flag with ms suffix', async () => {
    const ctx = makeStubContext();
    const talkSpy = handlers.cmdTalk;
    contextFactory.mockImplementation((opts) => {
      ctx.flags = opts.flags;
      return ctx;
    });
    expect(await runCli(['talk', 'claude', 'hi', '--timeout', '500ms'])).toBe(0);

    expect(ctx.flags.timeout).toBe(0.5);
    expect(talkSpy).toHaveBeenCalledOnce();
  });

  it('parses --detach flag', async () => {
    const ctx = makeStubContext();
    const talkSpy = handlers.cmdTalk;
    contextFactory.mockImplementation((opts) => {
      ctx.flags = opts.flags;
      return ctx;
    });
    expect(await runCli(['talk', 'claude', 'hi', '--detach'])).toBe(0);

    expect(ctx.flags.detach).toBe(true);
    expect(talkSpy).toHaveBeenCalledOnce();
  });

  it('rejects talk --lines before creating command context', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runCli(['talk', 'claude', 'hi', '--lines', '50'])).toBe(1);
    expect(contextFactory).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('parses --no-preamble flag', async () => {
    const ctx = makeStubContext();
    const talkSpy = handlers.cmdTalk;
    contextFactory.mockImplementation((opts) => {
      ctx.flags = opts.flags;
      return ctx;
    });
    expect(await runCli(['talk', 'claude', 'hi', '--no-preamble'])).toBe(0);

    expect(ctx.flags.noPreamble).toBe(true);
    expect(talkSpy).toHaveBeenCalledOnce();
  });

  it('routes check command with lines argument', async () => {
    const ctx = makeStubContext();
    const checkSpy = handlers.cmdCheck;
    contextFactory.mockImplementation(() => ctx);
    expect(await runCli(['check', 'claude', '50'])).toBe(0);

    expect(checkSpy).toHaveBeenCalledWith(ctx, 'claude', 50);
  });

  it('errors on talk with missing arguments', async () => {
    const argv = ['talk', 'claude']; // missing message

    const ctx = makeStubContext();
    contextFactory.mockImplementation(() => ctx);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runCli(argv)).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('errors on add with missing arguments', async () => {
    const argv = ['add', 'claude']; // missing global name

    const ctx = makeStubContext();
    contextFactory.mockImplementation(() => ctx);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runCli(argv)).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('errors on check with missing arguments', async () => {
    const argv = ['check']; // missing target

    const ctx = makeStubContext();
    contextFactory.mockImplementation(() => ctx);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await runCli(argv)).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  });
});
