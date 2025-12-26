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
const DEFAULT_CONFIG: GlobalConfig = {
  mode: 'polling',
  preambleMode: 'always',
  defaults: {
    timeout: 180,
    pollInterval: 1,
    captureLines: 100,
    preambleEvery: 3, // inject preamble every 3 messages
  },
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

/**
 * Search up parent directories for a file (like how git finds .git/).
 * Returns the path to the file if found, or null if not found.
 */
function findUpward(filename: string, startDir: string): string | null {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, filename);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      // Reached filesystem root
      return null;
    }
    dir = parent;
  }
}

export function resolvePaths(cwd: string = process.cwd()): Paths {
  const globalDir = resolveGlobalDir();

  // Search up for local config (like .git discovery)
  const localConfigPath =
    findUpward(LOCAL_CONFIG_FILENAME, cwd) ?? path.join(cwd, LOCAL_CONFIG_FILENAME);

  return {
    globalDir,
    globalConfig: path.join(globalDir, CONFIG_FILENAME),
    localConfig: localConfigPath,
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

  // Merge global config (mode, preambleMode, defaults only)
  const globalConfig = loadJsonFile<Partial<GlobalConfig>>(paths.globalConfig);
  if (globalConfig) {
    if (globalConfig.mode) config.mode = globalConfig.mode;
    if (globalConfig.preambleMode) config.preambleMode = globalConfig.preambleMode;
    if (globalConfig.defaults) {
      config.defaults = { ...config.defaults, ...globalConfig.defaults };
    }
  }

  // Load local config (pane registry + optional settings + agent config)
  // Local config is the SSOT for agent configuration (preamble, deny)
  const localConfigFile = loadJsonFile<LocalConfigFile>(paths.localConfig);
  if (localConfigFile) {
    // Extract local settings if present
    const { $config: localSettings, ...paneEntries } = localConfigFile;

    // Merge local settings (override global)
    if (localSettings) {
      if (localSettings.mode) config.mode = localSettings.mode;
      if (localSettings.preambleMode) config.preambleMode = localSettings.preambleMode;
      if (localSettings.preambleEvery !== undefined) {
        config.defaults.preambleEvery = localSettings.preambleEvery;
      }
    }

    // Build pane registry and agents config from local entries
    for (const [agentName, entry] of Object.entries(paneEntries)) {
      const paneEntry = entry as LocalConfig[string];

      // Add to pane registry if has valid pane field
      if (paneEntry.pane) {
        config.paneRegistry[agentName] = paneEntry;
      }

      // Build agents config from preamble/deny fields
      const hasPreamble = Object.prototype.hasOwnProperty.call(paneEntry, 'preamble');
      const hasDeny = Object.prototype.hasOwnProperty.call(paneEntry, 'deny');

      if (hasPreamble || hasDeny) {
        config.agents[agentName] = {
          ...(hasPreamble && { preamble: paneEntry.preamble }),
          ...(hasDeny && { deny: paneEntry.deny }),
        };
      }
    }
  }

  return config;
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
