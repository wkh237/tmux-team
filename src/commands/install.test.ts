import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import os from 'os';
import path from 'path';
import type { Context, Flags, Paths, ResolvedConfig, Tmux, UI } from '../types.js';
import { ExitCodes } from '../exits.js';
import { ALL_SKILL_TARGET, SKILL_AGENTS } from '../skill-installation.js';
import { createDefaultConfig } from '../config-settings.js';

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
    databaseFile: path.join(testDir, 'tmux-team.db'),
  };
  const config: ResolvedConfig = createDefaultConfig();
  const flags: Flags = { json: false, verbose: false, ...overrides?.flags } as Flags;
  const tmux: Tmux = {
    send: vi.fn(),
    capture: vi.fn(),
    listPanes: vi.fn(() => []),
    getCurrentPaneId: vi.fn(() => null),
    resolvePaneTarget: vi.fn((target: string) => target),
    setPaneTitle: vi.fn(),
  };
  return {
    argv: [],
    flags,
    ui: createMockUI(),
    config,
    tmux,
    identityService: {
      bindCurrent: vi.fn(),
      bindPane: vi.fn(),
      unbindCurrent: vi.fn(),
      currentIdentity: vi.fn(),
      resolveIdentity: vi.fn(),
      activeIdentities: vi.fn(() => []),
      resolveActive: vi.fn(),
      reconcile: vi.fn(),
    },
    get requestService(): Context['requestService'] {
      throw new Error('Unexpected request service access.');
    },
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
    vi.doUnmock('../skill-installation.js');
    vi.doUnmock('node:fs');
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
    expect(ctx.ui.info).toHaveBeenCalledWith(
      `Supported agents: ${[...SKILL_AGENTS, ALL_SKILL_TARGET].join(', ')}`
    );
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
    const { ensureManagedLink } = await import('../skill-installation.js');
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
    const { ensureManagedLink } = await import('../skill-installation.js');
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
    expect(ctx.ui.success).toHaveBeenCalledTimes(SKILL_AGENTS.length);
    expect(
      fs.lstatSync(path.join(homeDir, '.agents', 'skills', 'tmux-team')).isSymbolicLink()
    ).toBe(true);
    expect(
      fs.lstatSync(path.join(homeDir, '.claude', 'commands', 'team.md')).isSymbolicLink()
    ).toBe(true);
  });

  it('derives install-all order from the shared provider inventory', async () => {
    vi.resetModules();
    const reorderedAgents = ['gemini', 'claude'] as const;
    vi.doMock('../skill-installation.js', async () => {
      const actual = await vi.importActual<typeof import('../skill-installation.js')>(
        '../skill-installation.js'
      );
      return { ...actual, SKILL_AGENTS: reorderedAgents };
    });

    const { cmdInstall } = await import('./install.js');
    const ctx = createCtx(testDir, { flags: { force: true, json: true } });
    await cmdInstall(ctx, 'all');

    expect(ctx.ui.json).toHaveBeenCalledWith({
      installed: reorderedAgents.map((agent) => expect.objectContaining({ agent, changed: true })),
    });
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

  it('installs the universal skill into a custom directory without inventing an agent', async () => {
    vi.resetModules();
    vi.doMock('node:os', () => ({
      default: { homedir: () => homeDir },
      homedir: () => homeDir,
    }));
    const { cmdInstall } = await import('./install.js');
    const customDirectory = path.join(testDir, 'custom skills');
    const ctx = createCtx(testDir, { flags: { force: true, json: true } });

    await cmdInstall(ctx, undefined, customDirectory);
    await cmdInstall(ctx, undefined, customDirectory);

    const target = path.join(customDirectory, 'tmux-team');
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(ctx.ui.json).toHaveBeenLastCalledWith({
      installed: [{ target, changed: false }],
    });
  });

  it('preserves custom legacy paths and backs up unmanaged custom targets only with force', async () => {
    vi.resetModules();
    vi.doMock('node:os', () => ({
      default: { homedir: () => homeDir },
      homedir: () => homeDir,
    }));
    const { cmdInstall } = await import('./install.js');
    const customDirectory = path.join(testDir, 'custom skills');
    const target = path.join(customDirectory, 'tmux-team');
    const legacy = path.join(homeDir, '.codex', 'skills', 'tmux-team');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'SKILL.md'), 'legacy');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'user.md'), 'user-owned content');
    fs.writeFileSync(path.join(customDirectory, 'sibling.txt'), 'keep');

    const refused = createCtx(testDir);
    await expect(cmdInstall(refused, undefined, customDirectory)).rejects.toThrow(
      `exit(${ExitCodes.ERROR})`
    );
    expect(fs.readFileSync(path.join(target, 'user.md'), 'utf8')).toBe('user-owned content');
    expect(fs.existsSync(path.join(legacy, 'SKILL.md'))).toBe(true);

    const forced = createCtx(testDir, { flags: { force: true } });
    await cmdInstall(forced, undefined, customDirectory);
    expect(fs.readFileSync(path.join(customDirectory, 'sibling.txt'), 'utf8')).toBe('keep');
    expect(fs.existsSync(path.join(legacy, 'SKILL.md'))).toBe(true);
    const backup = fs
      .readdirSync(customDirectory)
      .find((entry) => entry.startsWith('tmux-team.backup-'));
    expect(backup).toBeDefined();
    expect(fs.statSync(path.join(customDirectory, backup!)).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(customDirectory, backup!, 'user.md'), 'utf8')).toBe(
      'user-owned content'
    );
  });

  it('rejects source-equal targets reached through symlinked parents without mutation', async () => {
    const { assertSafeSkillTarget } = await import('../skill-installation.js');
    const source = path.join(testDir, 'bundled', 'tmux-team');
    const sourceFile = path.join(source, 'SKILL.md');
    const sourceParentAlias = path.join(testDir, 'source parent alias');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(sourceFile, 'disposable source');
    fs.symlinkSync(path.dirname(source), sourceParentAlias, 'dir');
    const target = path.join(sourceParentAlias, 'tmux-team');

    expect(() => assertSafeSkillTarget(source, target)).toThrow(
      `Skill target overlaps bundled source: ${target}`
    );
    expect(() => assertSafeSkillTarget(source, path.dirname(source))).toThrow(
      'Skill target overlaps bundled source'
    );
    expect(fs.readFileSync(sourceFile, 'utf8')).toBe('disposable source');
    expect(fs.lstatSync(source).isDirectory()).toBe(true);
    expect(
      fs.readdirSync(path.dirname(source)).some((entry) => entry.startsWith('tmux-team.backup-'))
    ).toBe(false);
  });

  it('rejects targets beneath a source child whose name begins with two dots', async () => {
    const { assertSafeSkillTarget } = await import('../skill-installation.js');
    const source = path.join(testDir, 'bundled', 'tmux-team');
    const nestedDirectory = path.join(source, '..nested');
    const sourceFile = path.join(source, 'SKILL.md');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(sourceFile, 'disposable source');
    fs.mkdirSync(nestedDirectory);
    const target = path.join(nestedDirectory, 'tmux-team');

    try {
      expect(() => assertSafeSkillTarget(source, target)).toThrow(
        `Skill target overlaps bundled source: ${target}`
      );

      expect(fs.readFileSync(sourceFile, 'utf8')).toBe('disposable source');
      expect(fs.readdirSync(nestedDirectory)).toEqual([]);
    } finally {
      fs.rmSync(path.join(testDir, 'bundled'), { recursive: true, force: true });
    }
  });

  it('checks a missing bundled source before backing up a custom target', async () => {
    vi.resetModules();
    const fixtureRoot = path.join(testDir, 'missing-source-package');
    const customDirectory = path.join(testDir, 'custom missing source');
    const target = path.join(customDirectory, 'tmux-team');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'user.md'), 'user-owned content');
    vi.doMock('../skill-installation.js', async () => {
      const actual = await vi.importActual<typeof import('../skill-installation.js')>(
        '../skill-installation.js'
      );
      return { ...actual, packageRoot: () => fixtureRoot };
    });

    const { cmdInstall } = await import('./install.js');
    const ctx = createCtx(testDir, { flags: { force: true } });
    await expect(cmdInstall(ctx, undefined, customDirectory)).rejects.toThrow(
      `exit(${ExitCodes.ERROR})`
    );
    expect(fs.readFileSync(path.join(target, 'user.md'), 'utf8')).toBe('user-owned content');
    expect(fs.readdirSync(customDirectory)).toEqual(['tmux-team']);
  });

  it('requires SKILL.md before backing up a custom target', async () => {
    vi.resetModules();
    const fixtureRoot = path.join(testDir, 'incomplete-source-package');
    const source = path.join(fixtureRoot, 'skills', 'tmux-team');
    const customDirectory = path.join(testDir, 'custom incomplete source');
    const target = path.join(customDirectory, 'tmux-team');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'user.md'), 'user-owned content');
    vi.doMock('../skill-installation.js', async () => {
      const actual = await vi.importActual<typeof import('../skill-installation.js')>(
        '../skill-installation.js'
      );
      return { ...actual, packageRoot: () => fixtureRoot };
    });

    const { cmdInstall } = await import('./install.js');
    const ctx = createCtx(testDir, { flags: { force: true } });
    await expect(cmdInstall(ctx, undefined, customDirectory)).rejects.toThrow(
      `exit(${ExitCodes.ERROR})`
    );
    expect(fs.readFileSync(path.join(target, 'user.md'), 'utf8')).toBe('user-owned content');
    expect(fs.readdirSync(customDirectory)).toEqual(['tmux-team']);
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

  it('migrates an incomplete legacy Codex directory lacking SKILL.md with force', async () => {
    vi.resetModules();
    vi.doMock('node:os', () => ({
      default: { homedir: () => homeDir },
      homedir: () => homeDir,
    }));
    const legacy = path.join(homeDir, '.codex', 'skills', 'tmux-team');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'custom-data.json'), '{"partial":true}');

    const { inspectLocalDrift } = await import('../update-check.js');
    const { packageRoot } = await import('../skill-installation.js');
    const driftBefore = inspectLocalDrift({
      home: homeDir,
      root: packageRoot(),
      codexHome: path.join(homeDir, '.codex'),
    });
    expect(driftBefore).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'legacy',
          path: legacy,
        }),
      ])
    );

    const { cmdInstall } = await import('./install.js');
    const ctxWithoutForce = createCtx(testDir);
    await cmdInstall(ctxWithoutForce, 'codex');
    expect(fs.existsSync(path.join(legacy, 'custom-data.json'))).toBe(true);
    expect(ctxWithoutForce.ui.warn).toHaveBeenCalledWith(expect.stringContaining('--force'));

    const ctxWithForce = createCtx(testDir, { flags: { force: true } });
    await cmdInstall(ctxWithForce, 'codex');
    expect(fs.existsSync(legacy)).toBe(false);
    const backup = fs
      .readdirSync(path.dirname(legacy))
      .find((entry) => entry.startsWith('tmux-team.backup-'));
    expect(backup).toBeDefined();
    expect(
      fs.readFileSync(path.join(path.dirname(legacy), backup!, 'custom-data.json'), 'utf8')
    ).toBe('{"partial":true}');

    const driftAfter = inspectLocalDrift({
      home: homeDir,
      root: packageRoot(),
      codexHome: path.join(homeDir, '.codex'),
    });
    expect(driftAfter).toEqual([]);
  });

  it('honestly surfaces rename failures when backing up legacy copies', async () => {
    vi.resetModules();
    vi.doMock('node:os', () => ({
      default: { homedir: () => homeDir },
      homedir: () => homeDir,
    }));
    const legacy = path.join(homeDir, '.codex', 'skills', 'tmux-team');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'SKILL.md'), 'legacy');

    const renameSpy = vi.fn((_oldPath: string, _newPath: string) => {
      const error = new Error('EACCES: permission denied') as Error & { code: string };
      error.code = 'EACCES';
      throw error;
    });

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        default: {
          ...actual,
          renameSync: renameSpy,
        },
        renameSync: renameSpy,
      };
    });

    const { cmdInstall } = await import('./install.js');
    const ctx = createCtx(testDir, { flags: { force: true } });
    await expect(cmdInstall(ctx, 'codex')).rejects.toThrow(`exit(${ExitCodes.ERROR})`);

    expect(renameSpy).toHaveBeenCalledTimes(1);
    const [source, destination] = renameSpy.mock.calls[0];
    expect(source).toBe(legacy);
    expect(path.dirname(destination)).toBe(path.dirname(legacy));
    expect(path.basename(destination)).toMatch(/^tmux-team\.backup-\d+$/);

    // Original contents preserved
    expect(fs.existsSync(path.join(legacy, 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(legacy, 'SKILL.md'), 'utf8')).toBe('legacy');

    // No backup directory created
    const backups = fs
      .readdirSync(path.dirname(legacy))
      .filter((entry) => entry.startsWith('tmux-team.backup-'));
    expect(backups).toHaveLength(0);

    // No success or backup announcement
    expect(ctx.ui.success).not.toHaveBeenCalled();
    expect(ctx.ui.info).not.toHaveBeenCalled();
    expect(ctx.ui.error).toHaveBeenCalledWith(expect.stringContaining('permission denied'));
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
    const { getCodexHome } = await import('../skill-installation.js');
    const configured = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    try {
      expect(getCodexHome()).toBe(path.join(homeDir, '.codex'));
    } finally {
      process.env.CODEX_HOME = configured;
    }
  });
});
