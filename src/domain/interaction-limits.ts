export const MAX_CAPTURE_LINES = 2_147_483_647;
export const MAX_OBSERVER_TIMEOUT_SECONDS = 24 * 60 * 60;
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function isValidCaptureLines(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_CAPTURE_LINES
  );
}

export function isValidObserverTimeoutSeconds(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_OBSERVER_TIMEOUT_SECONDS
  );
}

export function isValidPollIntervalSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function isValidTimerDelayMs(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TIMER_DELAY_MS
  );
}
