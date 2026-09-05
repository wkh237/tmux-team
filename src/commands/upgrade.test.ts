import { describe, expect, it, vi } from 'vitest';
import type { Context } from '../types.js';

function context(json = false): Context {
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
    config: {} as Context['config'],
    tmux: {} as Context['tmux'],
    identityService: {
      bindCurrent: vi.fn(),
      bindPane: vi.fn(),
      unbindCurrent: vi.fn(),
      currentIdentity: vi.fn(),
      activeIdentities: vi.fn(() => []),
      resolveActive: vi.fn(),
      reconcile: vi.fn(),
    },
    get requestService(): Context['requestService'] {
      throw new Error('Unexpected request service access.');
    },
    paths: {
      globalDir: '/tmp/tmt',
      globalConfig: '',
      localConfig: '',
      stateFile: '',
      databaseFile: '',
    },
    exit: ((code: number) => {
      throw new Error(`exit(${code})`);
    }) as Context['exit'],
  };
}

describe('cmdUpgrade', () => {
  it('updates npm globally without mutating unselected integrations', async () => {
    vi.resetModules();
    const exec = vi.fn().mockReturnValueOnce('9.0.0\n');
    vi.doMock('node:child_process', () => ({ execFileSync: exec }));
    const { cmdUpgrade } = await import('./upgrade.js');
    const ctx = context();
    cmdUpgrade(ctx);
    expect(exec).toHaveBeenNthCalledWith(1, 'npm', ['view', 'tmux-team', 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(exec).toHaveBeenNthCalledWith(2, 'npm', ['install', '--global', 'tmux-team@latest'], {
      stdio: 'inherit',
    });
    expect(exec).toHaveBeenCalledTimes(2);
    expect(ctx.ui.success).toHaveBeenCalled();
  });

  it('does not downgrade a local version newer than the registry', async () => {
    vi.resetModules();
    const exec = vi.fn().mockReturnValue('4.2.0\n');
    vi.doMock('node:child_process', () => ({ execFileSync: exec }));
    const { cmdUpgrade } = await import('./upgrade.js');
    const ctx = context();
    cmdUpgrade(ctx);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(ctx.ui.success).toHaveBeenCalledWith(expect.stringContaining('already up to date'));
  });

  it('rejects JSON mode because installer output is streamed', async () => {
    vi.resetModules();
    const { cmdUpgrade } = await import('./upgrade.js');
    expect(() => cmdUpgrade(context(true))).toThrow('exit(1)');
  });

  it('reports npm update failures clearly', async () => {
    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(() => {
        throw new Error('permission denied');
      }),
    }));
    const { cmdUpgrade } = await import('./upgrade.js');
    const ctx = context();
    expect(() => cmdUpgrade(ctx)).toThrow('exit(1)');
    expect(ctx.ui.error).toHaveBeenCalledWith(expect.stringContaining('permission denied'));
  });
});
