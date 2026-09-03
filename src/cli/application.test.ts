import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '../types.js';

const handlers = {
  cmdInit: vi.fn(),
  cmdList: vi.fn(),
  cmdAdd: vi.fn(),
  cmdUpdate: vi.fn(),
  cmdRemove: vi.fn(),
  cmdTalk: vi.fn(),
  cmdCheck: vi.fn(),
  cmdConfig: vi.fn(),
  cmdPreamble: vi.fn(),
  cmdInstall: vi.fn(),
  cmdLearn: vi.fn(),
  cmdThis: vi.fn(),
  cmdMigrate: vi.fn(),
  cmdName: vi.fn(),
  cmdUpgrade: vi.fn(),
  cmdWhoami: vi.fn(),
  cmdUnbind: vi.fn(),
};

vi.mock('../commands/init.js', () => ({ cmdInit: handlers.cmdInit }));
vi.mock('../commands/list.js', () => ({ cmdList: handlers.cmdList }));
vi.mock('../commands/add.js', () => ({ cmdAdd: handlers.cmdAdd }));
vi.mock('../commands/update.js', () => ({ cmdUpdate: handlers.cmdUpdate }));
vi.mock('../commands/remove.js', () => ({ cmdRemove: handlers.cmdRemove }));
vi.mock('../commands/talk.js', () => ({ cmdTalk: handlers.cmdTalk }));
vi.mock('../commands/check.js', () => ({ cmdCheck: handlers.cmdCheck }));
vi.mock('../commands/config.js', () => ({ cmdConfig: handlers.cmdConfig }));
vi.mock('../commands/preamble.js', () => ({ cmdPreamble: handlers.cmdPreamble }));
vi.mock('../commands/install.js', () => ({ cmdInstall: handlers.cmdInstall }));
vi.mock('../commands/learn.js', () => ({ cmdLearn: handlers.cmdLearn }));
vi.mock('../commands/this.js', () => ({ cmdThis: handlers.cmdThis }));
vi.mock('../commands/migrate.js', () => ({ cmdMigrate: handlers.cmdMigrate }));
vi.mock('../commands/name.js', () => ({ cmdName: handlers.cmdName }));
vi.mock('../commands/upgrade.js', () => ({ cmdUpgrade: handlers.cmdUpgrade }));
vi.mock('../commands/whoami.js', () => ({ cmdWhoami: handlers.cmdWhoami }));
vi.mock('../commands/unbind.js', () => ({ cmdUnbind: handlers.cmdUnbind }));

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
      ['update', { name: 'claude', options: { remark: 'new' } }],
      ['remove', { name: 'claude' }],
      ['migrate', { dryRun: true, cleanup: false }],
      ['this', { name: 'claude' }],
      ['name', { name: 'claude' }],
      ['whoami', {}],
      ['unbind', {}],
      ['talk', { target, message: 'hello' }],
      ['check', { target, lines: 20 }],
      ['config', { operation: 'show', global: false }],
      ['preamble', { operation: 'show' }],
      ['install', { target: 'codex' }],
      ['upgrade', {}],
      ['learn', {}],
    ] as const;
    for (const [kind, values] of cases) await dispatchCommand(ctx, parsed({ kind, ...values }));
    expect(handlers.cmdInit).toHaveBeenCalledWith(ctx);
    expect(handlers.cmdList).toHaveBeenCalledWith(ctx, 'claude');
    expect(handlers.cmdTalk).toHaveBeenCalledWith(ctx, 'claude', 'hello');
    expect(handlers.cmdCheck).toHaveBeenCalledWith(ctx, 'claude', 20);
    expect(handlers.cmdConfig).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ operation: 'show' })
    );
    expect(handlers.cmdPreamble).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ operation: 'show' })
    );
  });

  it('does not route presentation-only invocations to application services', async () => {
    const ctx = {} as Context;
    await dispatchCommand(ctx, parsed({ kind: 'help', showIntro: false }));
    await dispatchCommand(ctx, parsed({ kind: 'version' }));
    await dispatchCommand(ctx, parsed({ kind: 'completion', shell: 'bash' }));
    expect(handlers.cmdInit).not.toHaveBeenCalled();
  });
});
