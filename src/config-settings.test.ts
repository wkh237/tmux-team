import { describe, expect, it } from 'vitest';
import {
  createDefaultConfig,
  createDefaultGlobalDefaults,
  ConfigValidationError,
  isValidConfigSettingValue,
  validateAndProjectGlobalConfig,
  validateAndProjectLocalSettings,
  validateGlobalConfigShape,
  validateLocalConfigShape,
} from './config-settings.js';

const file = '/tmp/tmux-team-config.json';

describe('config settings policy', () => {
  it('returns isolated canonical defaults', () => {
    const first = createDefaultConfig();
    const second = createDefaultConfig();
    first.defaults.timeout = 42;
    first.exchange.retentionDays = 1;
    expect(second).toEqual({
      preambleMode: 'always',
      defaults: {
        timeout: 180,
        pollInterval: 1,
        captureLines: 100,
        preambleEvery: 3,
        pasteEnterDelayMs: 500,
      },
      exchange: { retentionDays: 90 },
      ui: { paneBadge: 'off' },
    });
    expect(createDefaultGlobalDefaults()).toEqual(second.defaults);
  });

  it.each([
    ['preambleEvery', 0],
    ['preambleEvery', Number.MAX_SAFE_INTEGER],
    ['timeout', 1],
    ['timeout', 86_400],
    ['pollInterval', Number.MIN_VALUE],
    ['captureLines', 0],
    ['captureLines', 2_147_483_647],
    ['pasteEnterDelayMs', 0],
    ['pasteEnterDelayMs', 0.5],
    ['pasteEnterDelayMs', 2_147_483_647],
    ['exchange.retentionDays', 1],
    ['exchange.retentionDays', 3650],
    ['ui.paneBadge', 'on'],
    ['ui.paneBadge', 'off'],
  ] as const)('accepts %s=%s', (key, value) => {
    expect(isValidConfigSettingValue(key, value)).toBe(true);
  });

  it.each([
    ['preambleEvery', -1],
    ['preambleEvery', Number.MAX_SAFE_INTEGER + 1],
    ['preambleEvery', 1.5],
    ['timeout', 0],
    ['timeout', 86_401],
    ['pollInterval', 0],
    ['pollInterval', Infinity],
    ['captureLines', -1],
    ['captureLines', 2_147_483_648],
    ['captureLines', 1.5],
    ['pasteEnterDelayMs', -1],
    ['pasteEnterDelayMs', 2_147_483_648],
    ['exchange.retentionDays', 0],
    ['exchange.retentionDays', 3651],
    ['exchange.retentionDays', 1.5],
    ['ui.paneBadge', 'enabled'],
    ['ui.paneBadge', 'ON'],
  ] as const)('rejects %s=%s', (key, value) => {
    expect(isValidConfigSettingValue(key, value)).toBe(false);
  });

  it.each([null, '90', -1, 0, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER])(
    'rejects malformed global retention without treating %j as a default',
    (retentionDays) => {
      expect(() =>
        validateAndProjectGlobalConfig({ exchange: { retentionDays } }, file)
      ).toThrowError(ConfigValidationError);
    }
  );

  it.each([null, [], '90', 90])('rejects the invalid exchange container %j', (exchange) => {
    expect(() => validateAndProjectGlobalConfig({ exchange }, file)).toThrowError(
      ConfigValidationError
    );
  });

  it.each([null, [], 'on'])('rejects the invalid ui container %j', (ui) => {
    expect(() => validateAndProjectGlobalConfig({ ui }, file)).toThrowError(ConfigValidationError);
  });

  it('validates known values in global and local layers, including overridden values', () => {
    expect(() =>
      validateAndProjectGlobalConfig(
        { defaults: { timeout: 86_401 }, unrelated: { preserve: true } },
        file
      )
    ).toThrowError(ConfigValidationError);
    expect(() =>
      validateAndProjectGlobalConfig({ exchange: { retentionDays: 3651 } }, file)
    ).toThrowError(ConfigValidationError);
    expect(() =>
      validateAndProjectLocalSettings({ $config: { preambleEvery: null } }, file)
    ).toThrowError(ConfigValidationError);
    expect(() =>
      validateAndProjectGlobalConfig({ ui: { paneBadge: 'enabled' } }, file)
    ).toThrowError(ConfigValidationError);
  });

  it('projects known fields without importing unknown or retired fields', () => {
    expect(
      validateAndProjectGlobalConfig(
        {
          preambleMode: 'disabled',
          mode: 'wait',
          defaults: { timeout: 120, maxCaptureLines: 999, future: true },
          exchange: { retentionDays: 90, future: true },
          ui: { paneBadge: 'on', future: true },
        },
        file
      )
    ).toEqual({
      preambleMode: 'disabled',
      defaults: { timeout: 120 },
      exchange: { retentionDays: 90 },
      ui: { paneBadge: 'on' },
    });
    expect(
      validateAndProjectLocalSettings(
        {
          $config: {
            preambleMode: 'disabled',
            mode: 'wait',
            future: true,
            exchange: { retentionDays: 1 },
          },
        },
        file
      )
    ).toEqual({ $config: { preambleMode: 'disabled' } });
  });

  it('rejects a null or array global root', () => {
    const validate = validateGlobalConfigShape;
    expect(() => validate(null, file)).toThrowError(ConfigValidationError);
    expect(() => validate([], file)).toThrowError(ConfigValidationError);
  });

  it('rejects a null or array local root', () => {
    const validate = validateLocalConfigShape;
    expect(() => validate(null, file)).toThrowError(ConfigValidationError);
    expect(() => validate([], file)).toThrowError(ConfigValidationError);
  });

  it('rejects malformed known containers while allowing unknown fields', () => {
    expect(() => validateGlobalConfigShape({ defaults: null }, file)).toThrowError(
      ConfigValidationError
    );
    expect(() => validateGlobalConfigShape({ exchange: [] }, file)).toThrowError(
      ConfigValidationError
    );
    expect(() => validateGlobalConfigShape({ ui: [] }, file)).toThrowError(ConfigValidationError);
    expect(() => validateLocalConfigShape({ $config: [] }, file)).toThrowError(
      ConfigValidationError
    );
    expect(() => validateAndProjectGlobalConfig({ future: ['kept'] }, file)).not.toThrow();
  });
});
