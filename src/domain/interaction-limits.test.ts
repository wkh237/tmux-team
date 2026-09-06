import { describe, expect, it } from 'vitest';
import {
  MAX_CAPTURE_LINES,
  MAX_OBSERVER_TIMEOUT_SECONDS,
  MAX_TIMER_DELAY_MS,
  isValidCaptureLines,
  isValidObserverTimeoutSeconds,
  isValidPollIntervalSeconds,
  isValidTimerDelayMs,
} from './interaction-limits.js';

describe('interaction numeric limits', () => {
  it('keeps the external timer and capture ceilings explicit', () => {
    expect(MAX_CAPTURE_LINES).toBe(2_147_483_647);
    expect(MAX_OBSERVER_TIMEOUT_SECONDS).toBe(86_400);
    expect(MAX_TIMER_DELAY_MS).toBe(2_147_483_647);
  });

  it.each([0, MAX_CAPTURE_LINES])('accepts capture line boundary %s', (value) => {
    expect(isValidCaptureLines(value)).toBe(true);
  });

  it.each([-1, MAX_CAPTURE_LINES + 1, 1.5, Infinity, '10', null])(
    'rejects invalid capture lines %s',
    (value) => {
      expect(isValidCaptureLines(value)).toBe(false);
    }
  );

  it.each([1, MAX_OBSERVER_TIMEOUT_SECONDS])('accepts timeout boundary %s', (value) => {
    expect(isValidObserverTimeoutSeconds(value)).toBe(true);
  });

  it.each([0, -1, MAX_OBSERVER_TIMEOUT_SECONDS + 1, Infinity, Number.NaN, '30'])(
    'rejects invalid observer timeout %s',
    (value) => {
      expect(isValidObserverTimeoutSeconds(value)).toBe(false);
    }
  );

  it.each([Number.MIN_VALUE, 1, 0.001])('accepts positive poll interval %s', (value) => {
    expect(isValidPollIntervalSeconds(value)).toBe(true);
  });

  it.each([0, -1, Infinity, Number.NaN, '1'])('rejects invalid poll interval %s', (value) => {
    expect(isValidPollIntervalSeconds(value)).toBe(false);
  });

  it.each([0, MAX_TIMER_DELAY_MS, 0.5])('accepts timer delay boundary %s', (value) => {
    expect(isValidTimerDelayMs(value)).toBe(true);
  });

  it.each([-1, MAX_TIMER_DELAY_MS + 1, Infinity, Number.NaN, '0'])(
    'rejects invalid timer delay %s',
    (value) => {
      expect(isValidTimerDelayMs(value)).toBe(false);
    }
  );
});
