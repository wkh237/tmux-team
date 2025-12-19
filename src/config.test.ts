// ─────────────────────────────────────────────────────────────
// Config Tests - XDG path resolution and config hierarchy
// ─────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveGlobalDir, resolvePaths, loadConfig, ConfigParseError } from './config.js';

// Mock fs and os modules
vi.mock('fs');
vi.mock('os');

describe('resolveGlobalDir', () => {
  const mockHome = '/home/testuser';

  beforeEach(() => {
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    // Clear environment variables
    delete process.env.TMUX_TEAM_HOME;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('uses TMUX_TEAM_HOME when set (highest priority)', () => {
    process.env.TMUX_TEAM_HOME = '/custom/tmux-team';
    expect(resolveGlobalDir()).toBe('/custom/tmux-team');
  });

  it('uses XDG_CONFIG_HOME when set', () => {
    process.env.XDG_CONFIG_HOME = '/custom/config';
    expect(resolveGlobalDir()).toBe('/custom/config/tmux-team');
  });

  it('uses ~/.config/tmux-team when directory exists', () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      return p === path.join(mockHome, '.config', 'tmux-team');
    });
    expect(resolveGlobalDir()).toBe(path.join(mockHome, '.config', 'tmux-team'));
  });

  it('uses legacy ~/.tmux-team when it exists and XDG does not', () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      return p === path.join(mockHome, '.tmux-team');
    });
    expect(resolveGlobalDir()).toBe(path.join(mockHome, '.tmux-team'));
  });

  it('defaults to XDG style (~/.config/tmux-team) for new installs', () => {
    // Neither path exists
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(resolveGlobalDir()).toBe(path.join(mockHome, '.config', 'tmux-team'));
  });

  it('prefers path with config.json when both XDG and legacy exist', () => {
    const xdgPath = path.join(mockHome, '.config', 'tmux-team');
    const legacyPath = path.join(mockHome, '.tmux-team');
    const legacyConfig = path.join(legacyPath, 'config.json');

    vi.mocked(fs.existsSync).mockImplementation((p) => {
      // Both dirs exist, but only legacy has config.json
      if (p === xdgPath || p === legacyPath) return true;
      if (p === legacyConfig) return true;
      return false;
    });

    expect(resolveGlobalDir()).toBe(legacyPath);
  });

  it('prefers XDG when both exist and both have config.json', () => {
    const xdgPath = path.join(mockHome, '.config', 'tmux-team');
    const legacyPath = path.join(mockHome, '.tmux-team');
    const xdgConfig = path.join(xdgPath, 'config.json');
    const legacyConfig = path.join(legacyPath, 'config.json');

    vi.mocked(fs.existsSync).mockImplementation((p) => {
      // Both dirs exist with config.json
      if (p === xdgPath || p === legacyPath) return true;
      if (p === xdgConfig || p === legacyConfig) return true;
      return false;
    });

    expect(resolveGlobalDir()).toBe(xdgPath);
  });

  it('prefers XDG when only XDG has config.json', () => {
    const xdgPath = path.join(mockHome, '.config', 'tmux-team');
    const legacyPath = path.join(mockHome, '.tmux-team');
    const xdgConfig = path.join(xdgPath, 'config.json');

    vi.mocked(fs.existsSync).mockImplementation((p) => {
      if (p === xdgPath || p === legacyPath) return true;
      if (p === xdgConfig) return true;
      return false;
    });

    expect(resolveGlobalDir()).toBe(xdgPath);
  });
});

describe('resolvePaths', () => {
  const mockHome = '/home/testuser';
  const mockCwd = '/projects/myapp';

  beforeEach(() => {
    vi.mocked(os.homedir).mockReturnValue(mockHome);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    delete process.env.TMUX_TEAM_HOME;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns correct path structure', () => {
    const paths = resolvePaths(mockCwd);

    expect(paths.globalDir).toBe(path.join(mockHome, '.config', 'tmux-team'));
    expect(paths.globalConfig).toBe(path.join(mockHome, '.config', 'tmux-team', 'config.json'));
    expect(paths.localConfig).toBe(path.join(mockCwd, 'tmux-team.json'));
    expect(paths.stateFile).toBe(path.join(mockHome, '.config', 'tmux-team', 'state.json'));
  });

  it('uses TMUX_TEAM_HOME for global paths', () => {
    process.env.TMUX_TEAM_HOME = '/custom/path';
    const paths = resolvePaths(mockCwd);

    expect(paths.globalDir).toBe('/custom/path');
    expect(paths.globalConfig).toBe('/custom/path/config.json');
    expect(paths.stateFile).toBe('/custom/path/state.json');
  });
});

describe('loadConfig', () => {
  const mockPaths = {
    globalDir: '/home/test/.config/tmux-team',
    globalConfig: '/home/test/.config/tmux-team/config.json',
    localConfig: '/projects/myapp/tmux-team.json',
    stateFile: '/home/test/.config/tmux-team/state.json',
  };

  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns default config when no config files exist', () => {
    const config = loadConfig(mockPaths);

    expect(config.mode).toBe('polling');
    expect(config.preambleMode).toBe('always');
    expect(config.defaults.timeout).toBe(180);
    expect(config.defaults.pollInterval).toBe(1);
    expect(config.defaults.captureLines).toBe(100);
    expect(config.agents).toEqual({});
    expect(config.paneRegistry).toEqual({});
  });

  it('loads and merges global config', () => {
    const globalConfig = {
      mode: 'wait',
      preambleMode: 'disabled',
      defaults: { timeout: 120 },
      agents: { claude: { preamble: 'Be helpful' } },
    };

    vi.mocked(fs.existsSync).mockImplementation((p) => p === mockPaths.globalConfig);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(globalConfig));

    const config = loadConfig(mockPaths);

    expect(config.mode).toBe('wait');
    expect(config.preambleMode).toBe('disabled');
    expect(config.defaults.timeout).toBe(120);
    expect(config.defaults.pollInterval).toBe(1); // Default preserved
    expect(config.agents.claude?.preamble).toBe('Be helpful');
  });

  it('loads local pane registry from tmux-team.json', () => {
    const localConfig = {
      claude: { pane: '1.0', remark: 'Main assistant' },
      codex: { pane: '1.1' },
    };

    vi.mocked(fs.existsSync).mockImplementation((p) => p === mockPaths.localConfig);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(localConfig));

    const config = loadConfig(mockPaths);

    expect(config.paneRegistry.claude?.pane).toBe('1.0');
    expect(config.paneRegistry.claude?.remark).toBe('Main assistant');
    expect(config.paneRegistry.codex?.pane).toBe('1.1');
  });

  it('merges both global and local config', () => {
    const globalConfig = {
      agents: { claude: { preamble: 'Be brief' } },
    };
    const localConfig = {
      claude: { pane: '1.0' },
    };

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === mockPaths.globalConfig) return JSON.stringify(globalConfig);
      if (p === mockPaths.localConfig) return JSON.stringify(localConfig);
      return '';
    });

    const config = loadConfig(mockPaths);

    expect(config.agents.claude?.preamble).toBe('Be brief');
    expect(config.paneRegistry.claude?.pane).toBe('1.0');
  });

  it('throws ConfigParseError on invalid JSON in config file', () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p === mockPaths.globalConfig);
    vi.mocked(fs.readFileSync).mockReturnValue('{ invalid json }');

    expect(() => loadConfig(mockPaths)).toThrow(ConfigParseError);
  });

  it('ConfigParseError includes file path and cause', () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p === mockPaths.globalConfig);
    vi.mocked(fs.readFileSync).mockReturnValue('not json');

    try {
      loadConfig(mockPaths);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigParseError);
      const parseError = err as ConfigParseError;
      expect(parseError.filePath).toBe(mockPaths.globalConfig);
      expect(parseError.cause).toBeDefined();
    }
  });
});
