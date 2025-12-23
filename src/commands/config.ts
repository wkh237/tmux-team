// ─────────────────────────────────────────────────────────────
// Config command - view and modify settings
// ─────────────────────────────────────────────────────────────

import type { Context } from '../types.js';
import { ExitCodes } from '../context.js';
import {
  loadGlobalConfig,
  saveGlobalConfig,
  loadLocalConfigFile,
  saveLocalConfigFile,
  updateLocalSettings,
  clearLocalSettings,
} from '../config.js';

type EnumConfigKey = 'mode' | 'preambleMode';
type NumericConfigKey = 'preambleEvery';
type ConfigKey = EnumConfigKey | NumericConfigKey;

const ENUM_KEYS: EnumConfigKey[] = ['mode', 'preambleMode'];
const NUMERIC_KEYS: NumericConfigKey[] = ['preambleEvery'];
const VALID_KEYS: ConfigKey[] = [...ENUM_KEYS, ...NUMERIC_KEYS];

const VALID_VALUES: Record<EnumConfigKey, string[]> = {
  mode: ['polling', 'wait'],
  preambleMode: ['always', 'disabled'],
};

function isValidKey(key: string): key is ConfigKey {
  return VALID_KEYS.includes(key as ConfigKey);
}

function isEnumKey(key: ConfigKey): key is EnumConfigKey {
  return ENUM_KEYS.includes(key as EnumConfigKey);
}

function isNumericKey(key: ConfigKey): key is NumericConfigKey {
  return NUMERIC_KEYS.includes(key as NumericConfigKey);
}

function isValidValue(key: EnumConfigKey, value: string): boolean {
  return VALID_VALUES[key].includes(value);
}

/**
 * Show resolved config with source indicators.
 */
function showConfig(ctx: Context): void {
  const globalConfig = loadGlobalConfig(ctx.paths);
  const localConfigFile = loadLocalConfigFile(ctx.paths);
  const localSettings = localConfigFile.$config;

  if (ctx.flags.json) {
    ctx.ui.json({
      resolved: {
        mode: ctx.config.mode,
        preambleMode: ctx.config.preambleMode,
        preambleEvery: ctx.config.defaults.preambleEvery,
        defaults: ctx.config.defaults,
      },
      sources: {
        mode: localSettings?.mode ? 'local' : globalConfig.mode ? 'global' : 'default',
        preambleMode: localSettings?.preambleMode
          ? 'local'
          : globalConfig.preambleMode
            ? 'global'
            : 'default',
        preambleEvery:
          localSettings?.preambleEvery !== undefined
            ? 'local'
            : globalConfig.defaults?.preambleEvery !== undefined
              ? 'global'
              : 'default',
      },
      paths: {
        global: ctx.paths.globalConfig,
        local: ctx.paths.localConfig,
      },
    });
    return;
  }

  // Determine sources
  const modeSource = localSettings?.mode ? '(local)' : globalConfig.mode ? '(global)' : '(default)';
  const preambleSource = localSettings?.preambleMode
    ? '(local)'
    : globalConfig.preambleMode
      ? '(global)'
      : '(default)';
  const preambleEverySource =
    localSettings?.preambleEvery !== undefined
      ? '(local)'
      : globalConfig.defaults?.preambleEvery !== undefined
        ? '(global)'
        : '(default)';

  ctx.ui.info('Current configuration:\n');
  ctx.ui.table(
    ['Key', 'Value', 'Source'],
    [
      ['mode', ctx.config.mode, modeSource],
      ['preambleMode', ctx.config.preambleMode, preambleSource],
      ['preambleEvery', String(ctx.config.defaults.preambleEvery), preambleEverySource],
      ['defaults.timeout', String(ctx.config.defaults.timeout), '(global)'],
      ['defaults.pollInterval', String(ctx.config.defaults.pollInterval), '(global)'],
      ['defaults.captureLines', String(ctx.config.defaults.captureLines), '(global)'],
    ]
  );

  ctx.ui.info(`\nPaths:`);
  ctx.ui.info(`  Global: ${ctx.paths.globalConfig}`);
  ctx.ui.info(`  Local:  ${ctx.paths.localConfig}`);
}

/**
 * Set a config value.
 */
function setConfig(ctx: Context, key: string, value: string, global: boolean): void {
  if (!isValidKey(key)) {
    ctx.ui.error(`Invalid key: ${key}. Valid keys: ${VALID_KEYS.join(', ')}`);
    ctx.exit(ExitCodes.ERROR);
  }

  const validKey = key as ConfigKey;

  // Validate enum keys
  if (isEnumKey(validKey)) {
    if (!isValidValue(validKey, value)) {
      ctx.ui.error(
        `Invalid value for ${key}: ${value}. Valid values: ${VALID_VALUES[validKey].join(', ')}`
      );
      ctx.exit(ExitCodes.ERROR);
    }
  }

  // Validate numeric keys
  if (isNumericKey(validKey)) {
    const numValue = parseInt(value, 10);
    if (isNaN(numValue) || numValue < 0) {
      ctx.ui.error(`Invalid value for ${key}: ${value}. Must be a non-negative integer.`);
      ctx.exit(ExitCodes.ERROR);
    }
  }

  if (global) {
    // Set in global config
    const globalConfig = loadGlobalConfig(ctx.paths);
    if (key === 'mode') {
      globalConfig.mode = value as 'polling' | 'wait';
    } else if (key === 'preambleMode') {
      globalConfig.preambleMode = value as 'always' | 'disabled';
    } else if (key === 'preambleEvery') {
      if (!globalConfig.defaults) {
        globalConfig.defaults = {
          timeout: 180,
          pollInterval: 1,
          captureLines: 100,
          preambleEvery: parseInt(value, 10),
        };
      } else {
        globalConfig.defaults.preambleEvery = parseInt(value, 10);
      }
    }
    saveGlobalConfig(ctx.paths, globalConfig);
    ctx.ui.success(`Set ${key}=${value} in global config`);
  } else {
    // Set in local config
    if (key === 'mode') {
      updateLocalSettings(ctx.paths, { mode: value as 'polling' | 'wait' });
    } else if (key === 'preambleMode') {
      updateLocalSettings(ctx.paths, { preambleMode: value as 'always' | 'disabled' });
    } else if (key === 'preambleEvery') {
      updateLocalSettings(ctx.paths, { preambleEvery: parseInt(value, 10) });
    }
    ctx.ui.success(`Set ${key}=${value} in local config (repo override)`);
  }
}

/**
 * Clear local config override.
 */
function clearConfig(ctx: Context, key?: string): void {
  if (key) {
    if (!isValidKey(key)) {
      ctx.ui.error(`Invalid key: ${key}. Valid keys: ${VALID_KEYS.join(', ')}`);
      ctx.exit(ExitCodes.ERROR);
    }

    // Clear specific key from local settings
    const localConfigFile = loadLocalConfigFile(ctx.paths);
    if (localConfigFile.$config) {
      delete localConfigFile.$config[key];
      // Remove $config if empty
      if (Object.keys(localConfigFile.$config).length === 0) {
        delete localConfigFile.$config;
      }
      saveLocalConfigFile(ctx.paths, localConfigFile);
    }
    ctx.ui.success(`Cleared local override for ${key}`);
  } else {
    // Clear all local settings
    clearLocalSettings(ctx.paths);
    ctx.ui.success('Cleared all local config overrides');
  }
}

/**
 * Config command entry point.
 */
export function cmdConfig(ctx: Context, args: string[]): void {
  // Parse --global flag first, then determine subcommand
  const globalFlag = args.includes('--global') || args.includes('-g');
  const filteredArgs = args.filter((a) => a !== '--global' && a !== '-g');
  const subcommand = filteredArgs[0];

  switch (subcommand) {
    case undefined:
    case 'show':
      showConfig(ctx);
      break;

    case 'set':
      if (filteredArgs.length < 3) {
        ctx.ui.error('Usage: tmux-team config set <key> <value> [--global]');
        ctx.exit(ExitCodes.ERROR);
      }
      setConfig(ctx, filteredArgs[1], filteredArgs[2], globalFlag);
      break;

    case 'clear':
      clearConfig(ctx, filteredArgs[1]);
      break;

    default:
      ctx.ui.error(`Unknown config subcommand: ${subcommand}`);
      ctx.ui.error('Usage: tmux-team config [show|set|clear]');
      ctx.exit(ExitCodes.ERROR);
  }
}
