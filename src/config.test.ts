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

  it('searches up parent directories to find tmux-team.json', () => {
    // Simulating: cwd is /projects/myapp/src/components
    // tmux-team.json exists at /projects/myapp/tmux-team.json
    const nestedCwd = '/projects/myapp/src/components';
    const rootConfig = '/projects/myapp/tmux-team.json';

    vi.mocked(fs.existsSync).mockImplementation((p) => {
      return p === rootConfig;
    });

    const paths = resolvePaths(nestedCwd);

    // Should find the config in parent directory, not assume it's in cwd
    expect(paths.localConfig).toBe(rootConfig);
  });

  it('nearest tmux-team.json wins when multiple exist', () => {
    // Simulating: cwd is /projects/myapp/packages/frontend
    // tmux-team.json exists at both:
    //   /projects/myapp/tmux-team.json (monorepo root)
    //   /projects/myapp/packages/frontend/tmux-team.json (package-specific)
    const nestedCwd = '/projects/myapp/packages/frontend';
    const packageConfig = '/projects/myapp/packages/frontend/tmux-team.json';
    const monorepoConfig = '/projects/myapp/tmux-team.json';

    vi.mocked(fs.existsSync).mockImplementation((p) => {
      return p === packageConfig || p === monorepoConfig;
    });

    const paths = resolvePaths(nestedCwd);

    // Nearest config should win (package-specific, not monorepo root)
    expect(paths.localConfig).toBe(packageConfig);
  });

  it('falls back to cwd when no tmux-team.json found in parents', () => {
    // No tmux-team.json exists anywhere
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const paths = resolvePaths(mockCwd);

    // Should fall back to cwd/tmux-team.json (default behavior for init)
    expect(paths.localConfig).toBe(path.join(mockCwd, 'tmux-team.json'));
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

    expect(config.mode).toBe('wait');
    expect(config.preambleMode).toBe('always');
    expect(config.defaults.timeout).toBe(180);
    expect(config.defaults.pollInterval).toBe(1);
    expect(config.defaults.captureLines).toBe(100);
    expect(config.agents).toEqual({});
    expect(config.paneRegistry).toEqual({});
  });

  it('loads and merges global config (mode, preambleMode, defaults only)', () => {
    const globalConfig = {
      mode: 'wait',
      preambleMode: 'disabled',
      defaults: { timeout: 120 },
    };

    vi.mocked(fs.existsSync).mockImplementation((p) => p === mockPaths.globalConfig);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(globalConfig));

    const config = loadConfig(mockPaths);

    expect(config.mode).toBe('wait');
    expect(config.preambleMode).toBe('disabled');
    expect(config.defaults.timeout).toBe(120);
    expect(config.defaults.pollInterval).toBe(1); // Default preserved
    expect(config.agents).toEqual({}); // No agents from global config
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

  it('merges both global and local config (agents from local only)', () => {
    const globalConfig = {
      mode: 'wait',
    };
    const localConfig = {
      claude: { pane: '1.0', preamble: 'Be brief' },
    };

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === mockPaths.globalConfig) return JSON.stringify(globalConfig);
      if (p === mockPaths.localConfig) return JSON.stringify(localConfig);
      return '';
    });

    const config = loadConfig(mockPaths);

    expect(config.mode).toBe('wait'); // from global
    expect(config.agents.claude?.preamble).toBe('Be brief'); // from local
    expect(config.paneRegistry.claude?.pane).toBe('1.0'); // from local
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
      expect(parseError.cause).toBeInstanceOf(SyntaxError);
    }
  });

  it('loads local preamble into agents config', () => {
    const localConfig = {
      claude: { pane: '1.0', preamble: 'Be helpful and concise' },
    };

    vi.mocked(fs.existsSync).mockImplementation((p) => p === mockPaths.localConfig);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(localConfig));

    const config = loadConfig(mockPaths);

    expect(config.agents.claude?.preamble).toBe('Be helpful and concise');
    expect(config.paneRegistry.claude?.pane).toBe('1.0');
  });

  it('loads local deny into agents config', () => {
    const localConfig = {
      claude: { pane: '1.0', deny: ['pm:task:update(status)'] },
    };

    vi.mocked(fs.existsSync).mockImplementation((p) => p === mockPaths.localConfig);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(localConfig));

    const config = loadConfig(mockPaths);

    expect(config.agents.claude?.deny).toEqual(['pm:task:update(status)']);
  });

  it('loads preamble from local config only', () => {
    const localConfig = {
      claude: { pane: '1.0', preamble: 'Local preamble' },
    };

    vi.mocked(fs.existsSync).mockImplementation((p) => p === mockPaths.localConfig);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(localConfig));

    const config = loadConfig(mockPaths);

    expect(config.agents.claude?.preamble).toBe('Local preamble');
  });

  it('loads deny from local config only', () => {
    const localConfig = {
      claude: { pane: '1.0', deny: ['pm:task:create'] },
    };

    vi.mocked(fs.existsSync).mockImplementation((p) => p === mockPaths.localConfig);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(localConfig));

    const config = loadConfig(mockPaths);

    expect(config.agents.claude?.deny).toEqual(['pm:task:create']);
  });

  it('handles local config with both preamble and deny', () => {
    const localConfig = {
      claude: { pane: '1.0', preamble: 'Be helpful', deny: ['pm:task:update(status)'] },
    };

    vi.mocked(fs.existsSync).mockImplementation((p) => p === mockPaths.localConfig);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(localConfig));

    const config = loadConfig(mockPaths);

    expect(config.agents.claude?.preamble).toBe('Be helpful');
    expect(config.agents.claude?.deny).toEqual(['pm:task:update(status)']);
  });

  it('handles empty preamble in local config', () => {
    const localConfig = {
      claude: { pane: '1.0', preamble: '' },
    };

    vi.mocked(fs.existsSync).mockImplementation((p) => p === mockPaths.localConfig);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(localConfig));

    const config = loadConfig(mockPaths);

    expect(config.agents.claude?.preamble).toBe('');
  });

  it('handles empty deny array in local config', () => {
    const localConfig = {
      claude: { pane: '1.0', deny: [] },
    };

    vi.mocked(fs.existsSync).mockImplementation((p) => p === mockPaths.localConfig);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(localConfig));

    const config = loadConfig(mockPaths);

    expect(config.agents.claude?.deny).toEqual([]);
  });

  it('skips entries without pane field in paneRegistry', () => {
    const localConfig = {
      claude: { pane: '1.0' },
      codex: { preamble: 'Preamble only, no pane' },
    };

    vi.mocked(fs.existsSync).mockImplementation((p) => p === mockPaths.localConfig);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(localConfig));

    const config = loadConfig(mockPaths);

    expect(config.paneRegistry.claude?.pane).toBe('1.0');
    expect(config.paneRegistry.codex).toBeUndefined();
    // But preamble should still be merged
    expect(config.agents.codex?.preamble).toBe('Preamble only, no pane');
  });

  it('ignores agents field in global config (local config is SSOT)', () => {
    // Even if global config has agents, they should be ignored
    const globalConfig = {
      mode: 'wait',
      agents: {
        // This should be ignored
        claude: { preamble: 'Global preamble', deny: ['pm:task:delete'] },
      },
    };
    const localConfig = {
      claude: { pane: '1.0', preamble: 'Local preamble' },
    };

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === mockPaths.globalConfig) return JSON.stringify(globalConfig);
      if (p === mockPaths.localConfig) return JSON.stringify(localConfig);
      return '';
    });

    const config = loadConfig(mockPaths);

    // Mode from global should work
    expect(config.mode).toBe('wait');
    // But agents come only from local config
    expect(config.agents.claude?.preamble).toBe('Local preamble');
    expect(config.agents.claude?.deny).toBeUndefined(); // Not from global
  });

  it('local config defines project-specific agent roles without global pollution', () => {
    // No global config
    const localConfig = {
      claude: {
        pane: '1.0',
        remark: 'Main implementer',
        preamble: 'You implement features. Ask Codex for review.',
        deny: ['pm:task:update(status)', 'pm:milestone:update(status)'],
      },
      codex: {
        pane: '1.1',
        remark: 'Code quality guard',
        preamble: 'You review code. You can update task status.',
        // No deny - codex can do everything
      },
    };

    vi.mocked(fs.existsSync).mockImplementation((p) => p === mockPaths.localConfig);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(localConfig));

    const config = loadConfig(mockPaths);

    // Claude has deny rules
    expect(config.agents.claude?.deny).toEqual([
      'pm:task:update(status)',
      'pm:milestone:update(status)',
    ]);
    expect(config.agents.claude?.preamble).toBe('You implement features. Ask Codex for review.');

    // Codex has no deny rules (full access)
    expect(config.agents.codex?.deny).toBeUndefined();
    expect(config.agents.codex?.preamble).toBe('You review code. You can update task status.');
  });
});
