// ─────────────────────────────────────────────────────────────
// Config Tests - XDG path resolution and config hierarchy
// ─────────────────────────────────────────────────────────────

import { describe, it } from 'vitest';

describe('resolvePaths', () => {
  // Test XDG_CONFIG_HOME environment variable takes precedence
  it.todo('uses XDG_CONFIG_HOME when set');

  // Test TMUX_TEAM_HOME escape hatch
  it.todo('uses TMUX_TEAM_HOME when set (highest priority)');

  // Test fallback to ~/.config/tmux-team when XDG dir exists
  it.todo('uses ~/.config/tmux-team when directory exists');

  // Test fallback to legacy ~/.tmux-team when it exists
  it.todo('uses legacy ~/.tmux-team when it exists and XDG does not');

  // Test new install defaults to XDG style
  it.todo('defaults to XDG style (~/.config/tmux-team) for new installs');

  // Edge case: both paths exist - prefer one with config.json
  it.todo('prefers path with config.json when both XDG and legacy exist');
});

describe('loadConfig', () => {
  // Test default config values when no files exist
  it.todo('returns default config when no config files exist');

  // Test global config loading
  it.todo('loads and merges global config');

  // Test local config (pane registry) loading
  it.todo('loads local pane registry from tmux-team.json');

  // Test config hierarchy: defaults < global < local
  it.todo('local config overrides global config');

  // Test agent-specific config merging
  it.todo('merges agent-specific config from global');

  // Test ConfigParseError on invalid JSON
  it.todo('throws ConfigParseError on invalid JSON in config file');
});

describe('saveLocalConfig', () => {
  // Test writing pane registry
  it.todo('writes pane registry to tmux-team.json');

  // Test JSON formatting (pretty print)
  it.todo('formats JSON with 2-space indentation');
});

describe('ensureGlobalDir', () => {
  // Test directory creation
  it.todo('creates global directory if it does not exist');

  // Test no-op when directory exists
  it.todo('does nothing when directory already exists');
});
