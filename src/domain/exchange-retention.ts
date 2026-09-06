/** The default lifetime for newly prepared exchange records. */
export const DEFAULT_EXCHANGE_RETENTION_DAYS = 90;

/** The duration stamped onto records created by the pre-retention schema. */
export const LEGACY_EXCHANGE_RETENTION_DAYS = 7;

export const MIN_EXCHANGE_RETENTION_DAYS = 1;
export const MAX_EXCHANGE_RETENTION_DAYS = 3650;
export const RETENTION_DAY_MS = 24 * 60 * 60 * 1000;
export const EXCHANGE_RESPONSE_ACCEPTANCE_WINDOW_MS = 7 * RETENTION_DAY_MS;
export const EXCHANGE_METADATA_SETTLEMENT_FLOOR_MS = RETENTION_DAY_MS;

export function isValidExchangeRetentionDays(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= MIN_EXCHANGE_RETENTION_DAYS &&
    value <= MAX_EXCHANGE_RETENTION_DAYS
  );
}

export function assertExchangeRetentionDays(
  value: unknown,
  label = 'retention days'
): asserts value is number {
  if (!isValidExchangeRetentionDays(value)) {
    throw new Error(
      `${label} must be an integer from ${MIN_EXCHANGE_RETENTION_DAYS} through ${MAX_EXCHANGE_RETENTION_DAYS}.`
    );
  }
}

export function exchangeRetentionMs(retentionDays: number): number {
  assertExchangeRetentionDays(retentionDays);
  const duration = retentionDays * RETENTION_DAY_MS;
  if (!Number.isSafeInteger(duration)) {
    throw new Error('Exchange retention duration is outside the supported range.');
  }
  return duration;
}

export function addExchangeRetentionMs(
  anchorMs: number,
  retentionDays: number,
  label = 'exchange retention expiry'
): number {
  if (!Number.isSafeInteger(anchorMs) || anchorMs <= 0) {
    throw new Error(`${label} anchor is outside the supported range.`);
  }
  const duration = exchangeRetentionMs(retentionDays);
  if (anchorMs > Number.MAX_SAFE_INTEGER - duration) {
    throw new Error(`${label} is outside the supported range.`);
  }
  return anchorMs + duration;
}
