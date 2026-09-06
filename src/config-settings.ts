import type {
  ConfigDefaults,
  GlobalConfig,
  GlobalExchangeSettings,
  LocalSettings,
  ResolvedConfig,
} from './types.js';
import {
  isValidCaptureLines,
  isValidObserverTimeoutSeconds,
  isValidPollIntervalSeconds,
  isValidTimerDelayMs,
} from './domain/interaction-limits.js';
import {
  DEFAULT_EXCHANGE_RETENTION_DAYS,
  MAX_EXCHANGE_RETENTION_DAYS,
  MIN_EXCHANGE_RETENTION_DAYS,
  isValidExchangeRetentionDays,
} from './domain/exchange-retention.js';

const DEFAULT_CONFIG = {
  preambleMode: 'always',
  defaults: {
    timeout: 180,
    pollInterval: 1,
    captureLines: 100,
    preambleEvery: 3,
    pasteEnterDelayMs: 500,
  },
  exchange: {
    retentionDays: DEFAULT_EXCHANGE_RETENTION_DAYS,
  },
} as const;

type JsonObject = Record<string, unknown>;
export type ConfigSettingKey =
  | 'preambleMode'
  | 'timeout'
  | 'pollInterval'
  | 'captureLines'
  | 'preambleEvery'
  | 'pasteEnterDelayMs'
  | 'exchange.retentionDays';

export class ConfigValidationError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly field: string,
    message: string
  ) {
    super(`Invalid configuration in ${filePath} (${field}): ${message}`);
    this.name = 'ConfigValidationError';
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function invalidShape(filePath: string, field: string, expected: string): never {
  throw new ConfigValidationError(filePath, field, `must be ${expected}.`);
}

function validateObject(value: unknown, filePath: string, field: string): JsonObject {
  if (!isJsonObject(value)) invalidShape(filePath, field, 'a non-null object');
  return value;
}

function validateKnownField(
  value: unknown,
  filePath: string,
  field: string,
  valid: (candidate: unknown) => boolean,
  expected: string
): void {
  if (!valid(value)) throw new ConfigValidationError(filePath, field, `must be ${expected}.`);
}

function isValidPreambleEvery(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isValidPreambleMode(value: unknown): value is 'always' | 'disabled' {
  return value === 'always' || value === 'disabled';
}

interface SettingRule {
  readonly valid: (value: unknown) => boolean;
  readonly expected: string;
}

const SETTING_RULES: Record<ConfigSettingKey, SettingRule> = {
  preambleMode: { valid: isValidPreambleMode, expected: "'always' or 'disabled'" },
  timeout: {
    valid: isValidObserverTimeoutSeconds,
    expected: 'a finite positive number no greater than 86400',
  },
  pollInterval: { valid: isValidPollIntervalSeconds, expected: 'a finite positive number' },
  captureLines: {
    valid: isValidCaptureLines,
    expected: 'an integer from 0 through 2147483647',
  },
  preambleEvery: { valid: isValidPreambleEvery, expected: 'a safe non-negative integer' },
  pasteEnterDelayMs: {
    valid: isValidTimerDelayMs,
    expected: 'a finite number from 0 through 2147483647',
  },
  'exchange.retentionDays': {
    valid: isValidExchangeRetentionDays,
    expected: `an integer from ${MIN_EXCHANGE_RETENTION_DAYS} through ${MAX_EXCHANGE_RETENTION_DAYS}`,
  },
};

export function isValidConfigSettingValue(key: ConfigSettingKey, value: unknown): boolean {
  return SETTING_RULES[key].valid(value);
}

function validateKnownSettings(
  settings: JsonObject,
  filePath: string,
  prefix: string,
  names: readonly ConfigSettingKey[]
): void {
  for (const name of names) {
    if (!hasOwn(settings, name)) continue;
    const rule = SETTING_RULES[name];
    validateKnownField(settings[name], filePath, `${prefix}${name}`, rule.valid, rule.expected);
  }
}

/** Validate only the JSON container shape so a targeted config repair is possible. */
export function validateGlobalConfigShape(
  value: unknown,
  filePath: string
): asserts value is JsonObject {
  const root = validateObject(value, filePath, '<root>');
  if (hasOwn(root, 'defaults')) validateObject(root.defaults, filePath, 'defaults');
  if (hasOwn(root, 'exchange')) validateObject(root.exchange, filePath, 'exchange');
}

/** Validate only the JSON container shape so a targeted config repair is possible. */
export function validateLocalConfigShape(
  value: unknown,
  filePath: string
): asserts value is JsonObject {
  const root = validateObject(value, filePath, '<root>');
  if (hasOwn(root, '$config')) validateObject(root.$config, filePath, '$config');
}

export function validateGlobalConfig(
  value: unknown,
  filePath: string
): asserts value is JsonObject {
  validateGlobalConfigShape(value, filePath);
  const root = value;
  validateKnownSettings(root, filePath, '', ['preambleMode']);
  if (hasOwn(root, 'exchange')) {
    const exchange = root.exchange as JsonObject;
    if (hasOwn(exchange, 'retentionDays')) {
      const rule = SETTING_RULES['exchange.retentionDays'];
      validateKnownField(
        exchange.retentionDays,
        filePath,
        'exchange.retentionDays',
        rule.valid,
        rule.expected
      );
    }
  }
  if (!hasOwn(root, 'defaults')) return;
  const defaults = root.defaults as JsonObject;
  validateKnownSettings(defaults, filePath, 'defaults.', [
    'timeout',
    'pollInterval',
    'captureLines',
    'preambleEvery',
    'pasteEnterDelayMs',
  ]);
}

export function validateLocalConfig(value: unknown, filePath: string): asserts value is JsonObject {
  validateLocalConfigShape(value, filePath);
  const root = value;
  if (!hasOwn(root, '$config')) return;
  const settings = root.$config as JsonObject;
  validateKnownSettings(settings, filePath, '$config.', [
    'preambleMode',
    'preambleEvery',
    'pasteEnterDelayMs',
  ]);
}

export interface ValidatedGlobalConfig {
  readonly preambleMode?: GlobalConfig['preambleMode'];
  readonly defaults?: Partial<ConfigDefaults>;
  readonly exchange?: Pick<GlobalExchangeSettings, 'retentionDays'>;
}

export interface ValidatedLocalSettings {
  readonly $config?: LocalSettings;
}

function projectGlobalConfig(value: JsonObject): ValidatedGlobalConfig {
  const rawDefaults = isJsonObject(value.defaults) ? value.defaults : undefined;
  const rawExchange = isJsonObject(value.exchange) ? value.exchange : undefined;
  return {
    ...(value.preambleMode !== undefined && {
      preambleMode: value.preambleMode as GlobalConfig['preambleMode'],
    }),
    ...(rawDefaults && {
      defaults: {
        ...(rawDefaults.timeout !== undefined && { timeout: rawDefaults.timeout as number }),
        ...(rawDefaults.pollInterval !== undefined && {
          pollInterval: rawDefaults.pollInterval as number,
        }),
        ...(rawDefaults.captureLines !== undefined && {
          captureLines: rawDefaults.captureLines as number,
        }),
        ...(rawDefaults.preambleEvery !== undefined && {
          preambleEvery: rawDefaults.preambleEvery as number,
        }),
        ...(rawDefaults.pasteEnterDelayMs !== undefined && {
          pasteEnterDelayMs: rawDefaults.pasteEnterDelayMs as number,
        }),
      },
    }),
    ...(rawExchange?.retentionDays !== undefined && {
      exchange: { retentionDays: rawExchange.retentionDays as number },
    }),
  };
}

function projectLocalSettings(value: JsonObject): ValidatedLocalSettings {
  const rawSettings = isJsonObject(value.$config) ? value.$config : undefined;
  return {
    ...(rawSettings && {
      $config: {
        ...(rawSettings.preambleMode !== undefined && {
          preambleMode: rawSettings.preambleMode as LocalSettings['preambleMode'],
        }),
        ...(rawSettings.preambleEvery !== undefined && {
          preambleEvery: rawSettings.preambleEvery as number,
        }),
        ...(rawSettings.pasteEnterDelayMs !== undefined && {
          pasteEnterDelayMs: rawSettings.pasteEnterDelayMs as number,
        }),
      },
    }),
  };
}

export function validateAndProjectGlobalConfig(
  value: unknown,
  filePath: string
): ValidatedGlobalConfig {
  validateGlobalConfig(value, filePath);
  return projectGlobalConfig(value);
}

export function validateAndProjectLocalSettings(
  value: unknown,
  filePath: string
): ValidatedLocalSettings {
  validateLocalConfig(value, filePath);
  return projectLocalSettings(value);
}

export function createDefaultConfig(): ResolvedConfig {
  return {
    preambleMode: DEFAULT_CONFIG.preambleMode,
    defaults: { ...DEFAULT_CONFIG.defaults },
    exchange: { ...DEFAULT_CONFIG.exchange },
  };
}

export function createDefaultGlobalDefaults(): ConfigDefaults {
  return { ...DEFAULT_CONFIG.defaults };
}
