import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '../types.js';

const handlers = {
  cmdInit: vi.fn(),
  cmdList: vi.fn(),
  cmdAdd: vi.fn(),
  cmdTalk: vi.fn(),
  cmdCheck: vi.fn(),
  cmdConfig: vi.fn(),
  cmdPreamble: vi.fn(),
  cmdInstall: vi.fn(),
  cmdLearn: vi.fn(),
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

vi.mock('../commands/init.js', () => ({ cmdInit: handlers.cmdInit }));
vi.mock('../commands/list.js', () => ({ cmdList: handlers.cmdList }));
vi.mock('../commands/add.js', () => ({ cmdAdd: handlers.cmdAdd }));
vi.mock('../commands/talk.js', () => ({ cmdTalk: handlers.cmdTalk }));
vi.mock('../commands/check.js', () => ({ cmdCheck: handlers.cmdCheck }));
vi.mock('../commands/config.js', () => ({ cmdConfig: handlers.cmdConfig }));
vi.mock('../commands/preamble.js', () => ({ cmdPreamble: handlers.cmdPreamble }));
vi.mock('../commands/install.js', () => ({ cmdInstall: handlers.cmdInstall }));
vi.mock('../commands/learn.js', () => ({ cmdLearn: handlers.cmdLearn }));
vi.mock('../commands/this.js', () => ({ cmdThis: handlers.cmdThis }));
vi.mock('../commands/name.js', () => ({ cmdName: handlers.cmdName }));
vi.mock('../commands/upgrade.js', () => ({ cmdUpgrade: handlers.cmdUpgrade }));
vi.mock('../commands/whoami.js', () => ({ cmdWhoami: handlers.cmdWhoami }));
vi.mock('../commands/unbind.js', () => ({ cmdUnbind: handlers.cmdUnbind }));
vi.mock('../commands/role.js', () => ({ cmdRole: handlers.cmdRole }));
vi.mock('../commands/identity.js', () => ({ cmdIdentity: handlers.cmdIdentity }));
vi.mock('../commands/reply.js', () => ({ cmdReply: handlers.cmdReply }));
vi.mock('../commands/result.js', () => ({ cmdResult: handlers.cmdResult }));

const { dispatchCommand } = await import('./application.js');
const parsed = (invocation: any) => ({
  invocation,
  flags: { json: false, verbose: false },
  metadata: { argv: [], commandPath: [], unsupportedTeam: false, capability: 'tmux' as const },
});

describe('application dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dispatches every executable kind using typed values', async () => {
    const ctx = {} as Context;
    const target = { value: 'claude', kind: 'identity' as const };
    const cases = [
      ['init', {}],
      ['list', { target }],
      ['add', { pane: '1.0', name: 'claude' }],
      ['this', { name: 'claude' }],
      ['name', { name: 'claude' }],
      ['whoami', {}],
      ['unbind', {}],
      ['talk', { target, message: 'hello' }],
      ['check', { target, lines: 20 }],
      ['config', { operation: 'show', global: false }],
      ['preamble', { operation: 'show' }],
      ['role', { operation: 'show' }],
      ['identity', { operation: 'create', name: 'Alice' }],
      ['reply', { requestId: 'request-1', receipt: 'receipt', file: '/tmp/reply.txt' }],
      ['result', { requestId: 'request-1' }],
      ['install', { target: 'codex' }],
      ['upgrade', {}],
      ['learn', {}],
    ] as const;
    for (const [kind, values] of cases) await dispatchCommand(ctx, parsed({ kind, ...values }));
    await dispatchCommand(ctx, parsed({ kind: 'learn', skill: true }));
    expect(handlers.cmdInit).toHaveBeenCalledWith(ctx);
    expect(handlers.cmdList).toHaveBeenCalledWith(ctx, 'claude');
    expect(handlers.cmdTalk).toHaveBeenCalledWith(ctx, {
      kind: 'talk',
      target,
      message: 'hello',
    });
    expect(handlers.cmdCheck).toHaveBeenCalledWith(ctx, 'claude', 20);
    expect(handlers.cmdConfig).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ operation: 'show' })
    );
    expect(handlers.cmdPreamble).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ operation: 'show' })
    );
    expect(handlers.cmdRole).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ operation: 'show' })
    );
    expect(handlers.cmdIdentity).toHaveBeenCalledWith(ctx, {
      kind: 'identity',
      operation: 'create',
      name: 'Alice',
    });
    expect(handlers.cmdReply).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ kind: 'reply', requestId: 'request-1', file: '/tmp/reply.txt' })
    );
    expect(handlers.cmdResult).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ kind: 'result', requestId: 'request-1' })
    );
    expect(handlers.cmdLearn).toHaveBeenLastCalledWith(true);
  });

  it('passes the separate explicit originator through without flattening the talk request', async () => {
    const ctx = {} as Context;
    const request = {
      kind: 'talk' as const,
      target: { value: 'recipient', kind: 'identity' as const },
      message: 'original message',
      originator: { value: 'originator', kind: 'identity' as const, explicit: true },
    };
    await dispatchCommand(ctx, parsed(request));
    expect(handlers.cmdTalk).toHaveBeenCalledOnce();
    expect(handlers.cmdTalk).toHaveBeenCalledWith(ctx, request);
  });

  it('does not route presentation-only invocations to application services', async () => {
    const ctx = {} as Context;
    await dispatchCommand(ctx, parsed({ kind: 'help', showIntro: false }));
    await dispatchCommand(ctx, parsed({ kind: 'version' }));
    await dispatchCommand(ctx, parsed({ kind: 'completion', shell: 'bash' }));
    expect(handlers.cmdInit).not.toHaveBeenCalled();
  });
});
