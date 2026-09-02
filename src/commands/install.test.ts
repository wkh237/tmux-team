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
    defaults: {
      timeout: 180,
      pollInterval: 1,
      captureLines: 100,
      maxCaptureLines: 2000,
      preambleEvery: 3,
      pasteEnterDelayMs: 500,
    },
    agents: {},
    paneRegistry: {},
  };
  const flags: Flags = { json: false, verbose: false, ...(overrides?.flags ?? {}) } as Flags;
  const tmux: Tmux = {
    send: vi.fn(),
    capture: vi.fn(),
    listPanes: vi.fn(() => []),
    getCurrentPaneId: vi.fn(() => null),
    resolvePaneTarget: vi.fn((target: string) => target),
    setPaneTitle: vi.fn(),
    getAgentRegistry: vi.fn(() => ({ paneRegistry: {}, agents: {} })),
    setAgentRegistration: vi.fn(),
    clearAgentRegistration: vi.fn(() => false),
    listTeams: vi.fn(() => ({})),
    listTeamPanes: vi.fn(() => []),
    removeTeam: vi.fn(() => ({ removed: 0, agents: [] })),
    listGlobalIdentities: vi.fn(() => []),
    setGlobalIdentity: vi.fn(),
    clearGlobalIdentity: vi.fn(() => false),
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

  it('installs the universal skill when no environment is detected', async () => {
    vi.resetModules();
    vi.doMock('node:os', () => ({
      default: { homedir: () => homeDir },
      homedir: () => homeDir,
    }));
    vi.doMock('node:readline', () => ({
      createInterface: () => ({ close: () => {} }),
    }));

    const { cmdInstall } = await import('./install.js');
    const ctx = createCtx(testDir, { flags: { force: true } });
    await cmdInstall(ctx);

    const installed = path.join(homeDir, '.agents', 'skills', 'tmux-team', 'SKILL.md');
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

  it('installs all detected environments without prompting', async () => {
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

  it('keeps managed links idempotent and backs up unmanaged paths with --force', async () => {
    vi.resetModules();
    vi.doMock('node:os', () => ({
      default: { homedir: () => homeDir },
      homedir: () => homeDir,
    }));
    const { ensureManagedLink } = await import('./install.js');
    const source = path.join(testDir, 'source');
    const target = path.join(testDir, 'nested', 'skill');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'SKILL.md'), 'canonical');

    expect(ensureManagedLink(target, source)).toBeUndefined();
    expect(ensureManagedLink(target, source)).toBeUndefined();
    expect(fs.realpathSync(target)).toBe(fs.realpathSync(source));

    fs.rmSync(target, { recursive: true, force: true });
    fs.writeFileSync(target, 'local copy');
    const backup = ensureManagedLink(target, source, true);
    expect(backup).toBeDefined();
    expect(fs.readFileSync(backup!, 'utf8')).toBe('local copy');
    expect(fs.realpathSync(target)).toBe(fs.realpathSync(source));
  });

  it('can replace a broken symlink while preserving it as a backup', async () => {
    const { ensureManagedLink } = await import('./install.js');
    const source = path.join(testDir, 'source-file');
    const target = path.join(testDir, 'broken-file');
    fs.writeFileSync(source, 'canonical');
    fs.symlinkSync(path.join(testDir, 'missing-file'), target);
    const backup = ensureManagedLink(target, source, true);
    expect(backup).toBeDefined();
    expect(fs.lstatSync(backup!).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(target)).toBe(fs.realpathSync(source));
  });

  it('installs all integrations while sharing one Open Agent skill link', async () => {
    vi.resetModules();
    vi.doMock('node:os', () => ({
      default: { homedir: () => homeDir },
      homedir: () => homeDir,
    }));
    const { cmdInstall } = await import('./install.js');
    const ctx = createCtx(testDir, { flags: { force: true } });
    await cmdInstall(ctx, 'all');
    expect(ctx.ui.success).toHaveBeenCalledTimes(3);
    expect(
      fs.lstatSync(path.join(homeDir, '.agents', 'skills', 'tmux-team')).isSymbolicLink()
    ).toBe(true);
    expect(
      fs.lstatSync(path.join(homeDir, '.claude', 'commands', 'team.md')).isSymbolicLink()
    ).toBe(true);
  });

  it('returns machine-readable output in JSON mode', async () => {
    vi.resetModules();
    vi.doMock('node:os', () => ({
      default: { homedir: () => homeDir },
      homedir: () => homeDir,
    }));
    const { cmdInstall } = await import('./install.js');
    const ctx = createCtx(testDir, { flags: { force: true, json: true } });
    await cmdInstall(ctx, 'codex');
    expect(ctx.ui.json).toHaveBeenCalledWith(
      expect.objectContaining({
        installed: expect.arrayContaining([expect.objectContaining({ agent: 'codex' })]),
      })
    );
  });

  it('preserves a legacy Codex copy without force and explains migration', async () => {
    vi.resetModules();
    vi.doMock('node:os', () => ({
      default: { homedir: () => homeDir },
      homedir: () => homeDir,
    }));
    const legacy = path.join(homeDir, '.codex', 'skills', 'tmux-team');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'SKILL.md'), 'legacy');
    const { cmdInstall } = await import('./install.js');
    const ctx = createCtx(testDir);
    await cmdInstall(ctx, 'codex');
    expect(fs.existsSync(path.join(legacy, 'SKILL.md'))).toBe(true);
    expect(ctx.ui.warn).toHaveBeenCalledWith(expect.stringContaining('--force'));
  });

  it('moves legacy Codex copies to adjacent backups with force', async () => {
    vi.resetModules();
    vi.doMock('node:os', () => ({
      default: { homedir: () => homeDir },
      homedir: () => homeDir,
    }));
    const legacy = path.join(homeDir, '.codex', 'skills', 'tmux-team');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'SKILL.md'), 'legacy');
    const { cmdInstall } = await import('./install.js');
    const ctx = createCtx(testDir, { flags: { force: true } });
    await cmdInstall(ctx, 'codex');
    expect(fs.existsSync(legacy)).toBe(false);
    const backup = fs
      .readdirSync(path.dirname(legacy))
      .find((entry) => entry.startsWith('tmux-team.backup-'));
    expect(backup).toBeDefined();
    expect(fs.readFileSync(path.join(path.dirname(legacy), backup!, 'SKILL.md'), 'utf8')).toBe(
      'legacy'
    );
    expect(ctx.ui.info).toHaveBeenCalledWith(expect.stringContaining('recoverable backup'));
  });

  it('reports unsupported platforms before touching the filesystem', async () => {
    vi.resetModules();
    vi.doMock('node:os', () => ({
      default: { homedir: () => homeDir },
      homedir: () => homeDir,
    }));
    const { cmdInstall } = await import('./install.js');
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    try {
      const ctx = createCtx(testDir);
      await expect(cmdInstall(ctx, 'codex')).rejects.toThrow(`exit(${ExitCodes.ERROR})`);
      expect(ctx.ui.error).toHaveBeenCalledWith(expect.stringContaining('Darwin and Linux'));
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
    }
  });

  it('falls back to the conventional Codex home when CODEX_HOME is unset', async () => {
    vi.resetModules();
    vi.doMock('node:os', () => ({
      default: { homedir: () => homeDir },
      homedir: () => homeDir,
    }));
    const { getCodexHome } = await import('./install.js');
    const configured = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    try {
      expect(getCodexHome()).toBe(path.join(homeDir, '.codex'));
    } finally {
      process.env.CODEX_HOME = configured;
    }
  });
});
