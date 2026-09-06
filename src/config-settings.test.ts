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
    expect(second).toEqual({
      preambleMode: 'always',
      defaults: {
        timeout: 180,
        pollInterval: 1,
        captureLines: 100,
        preambleEvery: 3,
        pasteEnterDelayMs: 500,
      },
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
  ] as const)('rejects %s=%s', (key, value) => {
    expect(isValidConfigSettingValue(key, value)).toBe(false);
  });

  it('validates known values in global and local layers, including overridden values', () => {
    expect(() =>
      validateAndProjectGlobalConfig(
        { defaults: { timeout: 86_401 }, unrelated: { preserve: true } },
        file
      )
    ).toThrowError(ConfigValidationError);
    expect(() =>
      validateAndProjectLocalSettings({ $config: { preambleEvery: null } }, file)
    ).toThrowError(ConfigValidationError);
  });

  it('projects known fields without importing unknown or retired fields', () => {
    expect(
      validateAndProjectGlobalConfig(
        {
          preambleMode: 'disabled',
          mode: 'wait',
          defaults: { timeout: 120, maxCaptureLines: 999, future: true },
        },
        file
      )
    ).toEqual({ preambleMode: 'disabled', defaults: { timeout: 120 } });
    expect(
      validateAndProjectLocalSettings(
        { $config: { preambleMode: 'disabled', mode: 'wait', future: true } },
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
    expect(() => validateLocalConfigShape({ $config: [] }, file)).toThrowError(
      ConfigValidationError
    );
    expect(() => validateAndProjectGlobalConfig({ future: ['kept'] }, file)).not.toThrow();
  });
});
