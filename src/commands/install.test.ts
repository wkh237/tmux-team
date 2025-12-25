import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Context, Flags, Paths, ResolvedConfig, Tmux, UI } from '../types.js';
import { ExitCodes } from '../exits.js';

function createMockUI(): UI {
  return {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    table: vi.fn(),
    json: vi.fn(),
  };
}

function createCtx(testDir: string, overrides?: Partial<{ flags: Partial<Flags> }>): Context {
  const paths: Paths = {
    globalDir: testDir,
    globalConfig: path.join(testDir, 'config.json'),
    localConfig: path.join(testDir, 'tmux-team.json'),
    stateFile: path.join(testDir, 'state.json'),
  };
  const config: ResolvedConfig = {
    mode: 'polling',
    preambleMode: 'always',
    defaults: { timeout: 180, pollInterval: 1, captureLines: 100, preambleEvery: 3 },
    agents: {},
    paneRegistry: {},
  };
  const flags: Flags = { json: false, verbose: false, ...(overrides?.flags ?? {}) } as Flags;
  const tmux: Tmux = {
    send: vi.fn(),
    capture: vi.fn(),
    listPanes: vi.fn(() => []),
    getCurrentPaneId: vi.fn(() => null),
  };
  return {
    argv: [],
    flags,
    ui: createMockUI(),
    config,
    tmux,
    paths,
    exit: ((code: number) => {
      const err = new Error(`exit(${code})`);
      (err as Error & { exitCode: number }).exitCode = code;
      throw err;
    }) as any,
  };
}

describe('cmdInstall', () => {
  let testDir = '';
  let homeDir = '';
  const originalHome = process.env.HOME;
  const originalTmux = process.env.TMUX;
  const originalCodexHome = process.env.CODEX_HOME;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-team-install-'));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-team-home-'));
    process.env.HOME = homeDir;
    process.env.CODEX_HOME = path.join(homeDir, '.codex');
    delete process.env.TMUX;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.TMUX = originalTmux;
    process.env.CODEX_HOME = originalCodexHome;
    fs.rmSync(testDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('installs claude skill when agent is provided', async () => {
    vi.resetModules();
    vi.doMock('node:os', () => ({
      default: { homedir: () => homeDir },
      homedir: () => homeDir,
    }));
    vi.doMock('node:readline', () => ({
      createInterface: () => ({
        question: (_q: string, cb: (a: string) => void) => cb(''),
        close: () => {},
      }),
    }));

    const { cmdInstall } = await import('./install.js');
    const ctx = createCtx(testDir, { flags: { force: true } });
    await cmdInstall(ctx, 'claude');

    const installed = path.join(homeDir, '.claude', 'commands', 'team.md');
    expect(fs.existsSync(installed)).toBe(true);
  });

  it('errors on unknown agent', async () => {
    vi.resetModules();
    vi.doMock('node:os', () => ({
      default: { homedir: () => homeDir },
      homedir: () => homeDir,
    }));
    vi.doMock('node:readline', () => ({
      createInterface: () => ({
        question: (_q: string, cb: (a: string) => void) => cb(''),
        close: () => {},
      }),
    }));
    const { cmdInstall } = await import('./install.js');
    const ctx = createCtx(testDir);
    await expect(cmdInstall(ctx, 'nope')).rejects.toThrow(`exit(${ExitCodes.ERROR})`);
  });

  it('prompts when environment is not detected', async () => {
    vi.resetModules();
    const answers = ['codex'];
    vi.doMock('node:os', () => ({
      default: { homedir: () => homeDir },
      homedir: () => homeDir,
    }));
    vi.doMock('node:readline', () => ({
      createInterface: () => ({
        question: (_q: string, cb: (a: string) => void) => cb(answers.shift() ?? ''),
        close: () => {},
      }),
    }));

    const { cmdInstall } = await import('./install.js');
    const ctx = createCtx(testDir, { flags: { force: true } });
    await cmdInstall(ctx);

    const installed = path.join(homeDir, '.codex', 'skills', 'tmux-team', 'SKILL.md');
    expect(fs.existsSync(installed)).toBe(true);
  });

  it('auto-selects detected environment when exactly one is found', async () => {
    vi.resetModules();
    fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
    vi.doMock('node:os', () => ({
      default: { homedir: () => homeDir },
      homedir: () => homeDir,
    }));
    vi.doMock('node:readline', () => ({
      createInterface: () => ({
        question: (_q: string, cb: (a: string) => void) => cb(''),
        close: () => {},
      }),
    }));

    const { cmdInstall } = await import('./install.js');
    const ctx = createCtx(testDir, { flags: { force: true } });
    await cmdInstall(ctx);
    expect(fs.existsSync(path.join(homeDir, '.claude', 'commands', 'team.md'))).toBe(true);
  });

  it('prompts when multiple environments are detected', async () => {
    vi.resetModules();
    fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(homeDir, '.codex'), { recursive: true });

    vi.doMock('node:os', () => ({
      default: { homedir: () => homeDir },
      homedir: () => homeDir,
    }));

    const answers = ['claude'];
    vi.doMock('node:readline', () => ({
      createInterface: () => ({
        question: (_q: string, cb: (a: string) => void) => cb(answers.shift() ?? ''),
        close: () => {},
      }),
    }));

    const { cmdInstall } = await import('./install.js');
    const ctx = createCtx(testDir, { flags: { force: true } });
    await cmdInstall(ctx);
    expect(fs.existsSync(path.join(homeDir, '.claude', 'commands', 'team.md'))).toBe(true);
  });

  it('fails if skill exists and --force is not set', async () => {
    vi.resetModules();
    vi.doMock('node:os', () => ({
      default: { homedir: () => homeDir },
      homedir: () => homeDir,
    }));
    vi.doMock('node:readline', () => ({
      createInterface: () => ({
        question: (_q: string, cb: (a: string) => void) => cb(''),
        close: () => {},
      }),
    }));

    const target = path.join(homeDir, '.claude', 'commands', 'team.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'existing');

    const { cmdInstall } = await import('./install.js');
    const ctx = createCtx(testDir);
    await expect(cmdInstall(ctx, 'claude')).rejects.toThrow(`exit(${ExitCodes.ERROR})`);
    expect(ctx.ui.warn).toHaveBeenCalled();
  });
});
