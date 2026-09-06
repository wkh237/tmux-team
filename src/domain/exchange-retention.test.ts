import { describe, expect, it } from 'vitest';
import {
  addExchangeRetentionMs,
  DEFAULT_EXCHANGE_RETENTION_DAYS,
  isValidExchangeRetentionDays,
  MAX_EXCHANGE_RETENTION_DAYS,
  MIN_EXCHANGE_RETENTION_DAYS,
  RETENTION_DAY_MS,
} from './exchange-retention.js';

describe('exchange retention policy', () => {
  it('accepts only bounded safe integer day counts', () => {
    expect(isValidExchangeRetentionDays(MIN_EXCHANGE_RETENTION_DAYS)).toBe(true);
    expect(isValidExchangeRetentionDays(DEFAULT_EXCHANGE_RETENTION_DAYS)).toBe(true);
    expect(isValidExchangeRetentionDays(MAX_EXCHANGE_RETENTION_DAYS)).toBe(true);
    for (const value of [0, -1, 1.5, '90', null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(isValidExchangeRetentionDays(value)).toBe(false);
    }
  });

  it('checks the persisted expiry arithmetic instead of wrapping', () => {
    expect(addExchangeRetentionMs(1_700_000_000_000, 1)).toBe(1_700_000_000_000 + RETENTION_DAY_MS);
    expect(addExchangeRetentionMs(Number.MAX_SAFE_INTEGER - RETENTION_DAY_MS, 1)).toBe(
      Number.MAX_SAFE_INTEGER
    );
    expect(() => addExchangeRetentionMs(Number.MAX_SAFE_INTEGER - RETENTION_DAY_MS + 1, 1)).toThrow(
      'outside the supported range'
    );
    expect(() => addExchangeRetentionMs(Number.MAX_SAFE_INTEGER, 1)).toThrow(
      'outside the supported range'
    );
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects unsupported clock anchor %s',
    (anchor) => {
      expect(() => addExchangeRetentionMs(anchor, 1)).toThrow('anchor is outside');
    }
  );
});
