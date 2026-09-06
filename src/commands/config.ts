// ─────────────────────────────────────────────────────────────
// Config command - view and modify settings
// ─────────────────────────────────────────────────────────────

import type { Context } from '../types.js';
import { ExitCodes } from '../context.js';
import type { ConfigRequest } from '../cli/requests.js';
import {
  loadGlobalConfig,
  saveGlobalConfig,
  loadLocalConfigFile,
  saveLocalConfigFile,
  updateLocalSettings,
  clearLocalSettings,
} from '../config.js';
import { createDefaultGlobalDefaults, isValidConfigSettingValue } from '../config-settings.js';

type EnumConfigKey = 'preambleMode';
type NumericConfigKey = 'preambleEvery' | 'pasteEnterDelayMs' | 'exchange.retentionDays';
type ConfigKey = EnumConfigKey | NumericConfigKey;

const ENUM_KEYS: EnumConfigKey[] = ['preambleMode'];
const NUMERIC_KEYS: NumericConfigKey[] = [
  'preambleEvery',
  'pasteEnterDelayMs',
  'exchange.retentionDays',
];
const VALID_KEYS: ConfigKey[] = [...ENUM_KEYS, ...NUMERIC_KEYS];

function isValidKey(key: string): key is ConfigKey {
  return VALID_KEYS.includes(key as ConfigKey);
}

function isGlobalOnlyKey(key: ConfigKey): key is 'exchange.retentionDays' {
  return key === 'exchange.retentionDays';
}

type ParsedSetting =
  | { readonly key: EnumConfigKey; readonly value: 'always' | 'disabled' }
  | { readonly key: NumericConfigKey; readonly value: number };

function parseSetting(key: ConfigKey, value: string): ParsedSetting {
  if (key === 'preambleMode') {
    if (!isValidConfigSettingValue(key, value)) {
      throw new Error(`Invalid value for ${key}: ${value}. Valid values: always, disabled`);
    }
    return { key, value: value as 'always' | 'disabled' };
  }
  if (value.length === 0 || /\D/u.test(value)) {
    throw new Error(`Invalid value for ${key}: ${value}. Must be a non-negative integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || !isValidConfigSettingValue(key, parsed)) {
    throw new Error(
      `Invalid value for ${key}: ${value}. Must be a supported non-negative integer.`
    );
  }
  return { key, value: parsed };
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
        preambleMode: ctx.config.preambleMode,
        preambleEvery: ctx.config.defaults.preambleEvery,
        pasteEnterDelayMs: ctx.config.defaults.pasteEnterDelayMs,
        defaults: ctx.config.defaults,
        exchange: {
          retentionDays: ctx.config.exchange.retentionDays,
        },
      },
      sources: {
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
        pasteEnterDelayMs:
          localSettings?.pasteEnterDelayMs !== undefined
            ? 'local'
            : globalConfig.defaults?.pasteEnterDelayMs !== undefined
              ? 'global'
              : 'default',
        exchange: {
          retentionDays: globalConfig.exchange?.retentionDays !== undefined ? 'global' : 'default',
        },
      },
      paths: {
        global: ctx.paths.globalConfig,
        local: ctx.paths.localConfig,
      },
    });
    return;
  }

  // Determine sources
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
  const pasteEnterDelaySource =
    localSettings?.pasteEnterDelayMs !== undefined
      ? '(local)'
      : globalConfig.defaults?.pasteEnterDelayMs !== undefined
        ? '(global)'
        : '(default)';
  const exchangeRetentionSource =
    globalConfig.exchange?.retentionDays !== undefined ? '(global)' : '(default)';

  ctx.ui.info('Current configuration:\n');
  ctx.ui.table(
    ['Key', 'Value', 'Source'],
    [
      ['preambleMode', ctx.config.preambleMode, preambleSource],
      ['preambleEvery', String(ctx.config.defaults.preambleEvery), preambleEverySource],
      ['pasteEnterDelayMs', String(ctx.config.defaults.pasteEnterDelayMs), pasteEnterDelaySource],
      ['defaults.timeout', String(ctx.config.defaults.timeout), '(global)'],
      ['defaults.pollInterval', String(ctx.config.defaults.pollInterval), '(global)'],
      ['defaults.captureLines', String(ctx.config.defaults.captureLines), '(global)'],
      [
        'exchange.retentionDays',
        String(ctx.config.exchange.retentionDays),
        exchangeRetentionSource,
      ],
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

  if (!global && isGlobalOnlyKey(validKey)) {
    ctx.ui.error(`${validKey} can only be set in global config with --global.`);
    ctx.exit(ExitCodes.ERROR);
  }

  let parsed: ParsedSetting;
  try {
    parsed = parseSetting(validKey, value);
  } catch (error) {
    ctx.ui.error(error instanceof Error ? error.message : String(error));
    ctx.exit(ExitCodes.ERROR);
  }

  if (global) {
    // Set in global config
    const globalConfig = loadGlobalConfig(ctx.paths);
    if (parsed.key === 'preambleMode') {
      globalConfig.preambleMode = parsed.value;
    } else if (parsed.key === 'preambleEvery') {
      if (!globalConfig.defaults) {
        globalConfig.defaults = createDefaultGlobalDefaults();
      }
      globalConfig.defaults.preambleEvery = parsed.value;
    } else if (parsed.key === 'pasteEnterDelayMs') {
      if (!globalConfig.defaults) {
        globalConfig.defaults = createDefaultGlobalDefaults();
      }
      globalConfig.defaults.pasteEnterDelayMs = parsed.value;
    } else if (parsed.key === 'exchange.retentionDays') {
      globalConfig.exchange = { ...globalConfig.exchange, retentionDays: parsed.value };
    }
    saveGlobalConfig(ctx.paths, globalConfig);
    ctx.ui.success(`Set ${key}=${value} in global config`);
  } else {
    // Set in local config
    if (parsed.key === 'preambleMode') {
      updateLocalSettings(ctx.paths, { preambleMode: parsed.value });
    } else if (parsed.key === 'preambleEvery') {
      updateLocalSettings(ctx.paths, { preambleEvery: parsed.value });
    } else if (parsed.key === 'pasteEnterDelayMs') {
      updateLocalSettings(ctx.paths, { pasteEnterDelayMs: parsed.value });
    }
    ctx.ui.success(`Set ${key}=${value} in local config (repo override)`);
  }
}

/**
 * Clear local config override.
 */
function clearConfig(ctx: Context, key?: string): void {
  if (key) {
    // mode is an obsolete local-only key. It may be explicitly removed, but
    // it is not part of the runtime or config set/show surface anymore.
    const isObsoleteMode = key === 'mode';
    if (!isObsoleteMode && !isValidKey(key)) {
      ctx.ui.error(`Invalid key: ${key}. Valid keys: ${VALID_KEYS.join(', ')}`);
      ctx.exit(ExitCodes.ERROR);
    }

    if (isValidKey(key) && isGlobalOnlyKey(key)) {
      ctx.ui.error(`${key} is global-only and has no local override to clear.`);
      ctx.exit(ExitCodes.ERROR);
    }

    // Clear specific key from local settings
    const localConfigFile = loadLocalConfigFile(ctx.paths);
    if (localConfigFile.$config) {
      delete (localConfigFile.$config as unknown as Record<string, unknown>)[key];
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
export function cmdConfig(ctx: Context, request: ConfigRequest): void {
  switch (request.operation) {
    case 'show':
      showConfig(ctx);
      return;
    case 'set':
      if (request.key === undefined || request.value === undefined) {
        ctx.ui.error('Usage: tmux-team config set <key> <value> [--global]');
        ctx.exit(ExitCodes.ERROR);
      }
      setConfig(ctx, request.key, request.value, request.global);
      return;
    case 'clear':
      clearConfig(ctx, request.key);
      return;
  }
}
