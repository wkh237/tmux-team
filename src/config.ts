// ─────────────────────────────────────────────────────────────
// Config loading with XDG support and 3-tier hierarchy
// ─────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import os from 'os';
import type {
  GlobalConfig,
  LocalConfig,
  LocalConfigFile,
  LocalSettings,
  ResolvedConfig,
  Paths,
} from './types.js';

const CONFIG_FILENAME = 'config.json';
const LOCAL_CONFIG_FILENAME = 'tmux-team.json';
const STATE_FILENAME = 'state.json';

// Default configuration values
const DEFAULT_CONFIG: Omit<GlobalConfig, 'agents'> & { agents: Record<string, never> } = {
  mode: 'polling',
  preambleMode: 'always',
  defaults: {
    timeout: 180,
    pollInterval: 1,
    captureLines: 100,
  },
  agents: {},
};

/**
 * Resolve the global config directory path using XDG spec with smart detection.
 *
 * Priority:
 * 1. TMUX_TEAM_HOME env (escape hatch)
 * 2. XDG_CONFIG_HOME env → ${XDG_CONFIG_HOME}/tmux-team
 * 3. ~/.config/tmux-team/ exists → use XDG style
 * 4. ~/.tmux-team/ exists → use legacy
 * 5. Else (new install) → default to XDG
 */
export function resolveGlobalDir(): string {
  const home = os.homedir();

  // 1. Explicit override
  if (process.env.TMUX_TEAM_HOME) {
    return process.env.TMUX_TEAM_HOME;
  }

  // 2. XDG_CONFIG_HOME is set
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, 'tmux-team');
  }

  const xdgPath = path.join(home, '.config', 'tmux-team');
  const legacyPath = path.join(home, '.tmux-team');

  // 3. XDG path exists
  if (fs.existsSync(xdgPath)) {
    // Edge case: both exist - prefer the one with config.json
    if (fs.existsSync(legacyPath)) {
      const xdgHasConfig = fs.existsSync(path.join(xdgPath, CONFIG_FILENAME));
      const legacyHasConfig = fs.existsSync(path.join(legacyPath, CONFIG_FILENAME));

      if (legacyHasConfig && !xdgHasConfig) {
        return legacyPath;
      }
      // If both have config or only XDG has it, prefer XDG
    }
    return xdgPath;
  }

  // 4. Legacy path exists
  if (fs.existsSync(legacyPath)) {
    return legacyPath;
  }

  // 5. New install - default to XDG
  return xdgPath;
}

export function resolvePaths(cwd: string = process.cwd()): Paths {
  const globalDir = resolveGlobalDir();
  return {
    globalDir,
    globalConfig: path.join(globalDir, CONFIG_FILENAME),
    localConfig: path.join(cwd, LOCAL_CONFIG_FILENAME),
    stateFile: path.join(globalDir, STATE_FILENAME),
  };
}

export class ConfigParseError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly cause: Error
  ) {
    super(`Invalid JSON in ${filePath}: ${cause.message}`);
    this.name = 'ConfigParseError';
  }
}

function loadJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch (err) {
    // Throw on parse errors - don't silently ignore invalid config
    throw new ConfigParseError(filePath, err as Error);
  }
}

/**
 * Load and merge configuration from all tiers.
 *
 * Precedence (lowest → highest):
 * Defaults → Global config → Local config → CLI flags
 *
 * Note: CLI flags are applied by the caller after this function returns.
 */
export function loadConfig(paths: Paths): ResolvedConfig {
  // Start with defaults
  const config: ResolvedConfig = {
    ...DEFAULT_CONFIG,
    defaults: { ...DEFAULT_CONFIG.defaults },
    agents: {},
    paneRegistry: {},
  };

  // Merge global config
  const globalConfig = loadJsonFile<Partial<GlobalConfig>>(paths.globalConfig);
  if (globalConfig) {
    if (globalConfig.mode) config.mode = globalConfig.mode;
    if (globalConfig.preambleMode) config.preambleMode = globalConfig.preambleMode;
    if (globalConfig.defaults) {
      config.defaults = { ...config.defaults, ...globalConfig.defaults };
    }
    if (globalConfig.agents) {
      config.agents = { ...config.agents, ...globalConfig.agents };
    }
  }

  // Load local config (pane registry + optional settings)
  const localConfigFile = loadJsonFile<LocalConfigFile>(paths.localConfig);
  if (localConfigFile) {
    // Extract local settings if present
    const { $config: localSettings, ...paneEntries } = localConfigFile;

    // Merge local settings (override global)
    if (localSettings) {
      if (localSettings.mode) config.mode = localSettings.mode;
      if (localSettings.preambleMode) config.preambleMode = localSettings.preambleMode;
    }

    // Set pane registry (filter out $config)
    config.paneRegistry = paneEntries as LocalConfig;
  }

  return config;
}

export function saveLocalConfig(
  paths: Paths,
  paneRegistry: Record<string, { pane: string; remark?: string }>
): void {
  fs.writeFileSync(paths.localConfig, JSON.stringify(paneRegistry, null, 2) + '\n');
}

export function ensureGlobalDir(paths: Paths): void {
  if (!fs.existsSync(paths.globalDir)) {
    fs.mkdirSync(paths.globalDir, { recursive: true });
  }
}

/**
 * Load raw global config file (for editing).
 */
export function loadGlobalConfig(paths: Paths): Partial<GlobalConfig> {
  return loadJsonFile<Partial<GlobalConfig>>(paths.globalConfig) ?? {};
}

/**
 * Save global config file.
 */
export function saveGlobalConfig(paths: Paths, config: Partial<GlobalConfig>): void {
  ensureGlobalDir(paths);
  fs.writeFileSync(paths.globalConfig, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Load raw local config file (for editing).
 */
export function loadLocalConfigFile(paths: Paths): LocalConfigFile {
  return loadJsonFile<LocalConfigFile>(paths.localConfig) ?? {};
}

/**
 * Save local config file (preserves both $config and pane entries).
 */
export function saveLocalConfigFile(paths: Paths, configFile: LocalConfigFile): void {
  fs.writeFileSync(paths.localConfig, JSON.stringify(configFile, null, 2) + '\n');
}

/**
 * Update local settings (creates $config if needed).
 */
export function updateLocalSettings(paths: Paths, settings: LocalSettings): void {
  const configFile = loadLocalConfigFile(paths);
  configFile.$config = { ...configFile.$config, ...settings };
  saveLocalConfigFile(paths, configFile);
}

/**
 * Clear local settings.
 */
export function clearLocalSettings(paths: Paths): void {
  const configFile = loadLocalConfigFile(paths);
  delete configFile.$config;
  saveLocalConfigFile(paths, configFile);
}
