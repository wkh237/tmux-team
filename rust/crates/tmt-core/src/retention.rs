//! Frozen Exchange deadlines. Historical migration saturation is intentionally
//! separate; new runtime arithmetic fails rather than extending an invalid date.

use crate::limits::MAX_JS_SAFE_INTEGER;

pub const DEFAULT_RETENTION_DAYS: u64 = 90;
pub const MAX_RETENTION_DAYS: u64 = 3650;
pub const RETENTION_DAY_MS: u64 = 86_400_000;
pub const RESPONSE_ACCEPTANCE_WINDOW_MS: u64 = 7 * RETENTION_DAY_MS;
pub const METADATA_SETTLEMENT_FLOOR_MS: u64 = RETENTION_DAY_MS;
pub const REQUEST_MIN_EXPIRY_MS: u64 = 3_600_000;

pub fn valid_retention_days(days: u64) -> bool {
    (1..=MAX_RETENTION_DAYS).contains(&days)
}

pub fn checked_deadline(anchor_ms: u64, delta_ms: u64) -> Option<u64> {
    if anchor_ms == 0 {
        return None;
    }
    anchor_ms
        .checked_add(delta_ms)
        .filter(|value| *value <= MAX_JS_SAFE_INTEGER)
}

pub fn retention_deadline(anchor_ms: u64, days: u64) -> Option<u64> {
    valid_retention_days(days)
        .then(|| days * RETENTION_DAY_MS)
        .and_then(|delta| checked_deadline(anchor_ms, delta))
}

/// Avoid adding to historical anchors: the comparison remains meaningful at
/// the safe-integer ceiling and after wall-clock rollback.
pub fn response_deadline_passed(now_ms: u64, prepared_ms: u64, expires_ms: u64) -> bool {
    now_ms >= expires_ms
        && now_ms
            .checked_sub(prepared_ms)
            .is_some_and(|elapsed| elapsed >= RESPONSE_ACCEPTANCE_WINDOW_MS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retention_has_one_settings_owner_and_closed_day_bounds() {
        use crate::settings::{Scalar, Setting, SettingKey, Settings};
        assert_eq!(Settings::default().retention_days, DEFAULT_RETENTION_DAYS);
        for days in [
            0,
            1,
            90,
            MAX_RETENTION_DAYS,
            MAX_RETENTION_DAYS + 1,
            u64::MAX,
        ] {
            assert_eq!(
                valid_retention_days(days),
                Setting::validate(SettingKey::RetentionDays, Scalar::Number(days as f64)).is_some()
            );
        }
        for value in [-1.0, 1.5, f64::NAN, f64::INFINITY] {
            assert!(Setting::validate(SettingKey::RetentionDays, Scalar::Number(value)).is_none());
        }
    }

    #[test]
    fn new_deadlines_fail_at_invalid_anchor_or_safe_integer_overflow() {
        assert_eq!(checked_deadline(1, 0), Some(1));
        assert_eq!(
            checked_deadline(MAX_JS_SAFE_INTEGER - 1, 1),
            Some(MAX_JS_SAFE_INTEGER)
        );
        assert_eq!(checked_deadline(MAX_JS_SAFE_INTEGER, 1), None);
        assert_eq!(checked_deadline(0, 1), None);
        assert_eq!(checked_deadline(1, u64::MAX), None);
        assert_eq!(retention_deadline(1, 1), Some(86_400_001));
        assert_eq!(retention_deadline(1, 3650), Some(315_360_000_001));
        for days in [0, 3651, u64::MAX] {
            assert_eq!(retention_deadline(1, days), None);
        }
        assert_eq!(
            retention_deadline(MAX_JS_SAFE_INTEGER - RETENTION_DAY_MS, 1),
            Some(MAX_JS_SAFE_INTEGER)
        );
        assert_eq!(
            retention_deadline(MAX_JS_SAFE_INTEGER - RETENTION_DAY_MS + 1, 1),
            None
        );
    }

    #[test]
    fn acceptance_uses_later_deadline_and_equality_without_overflow() {
        let prepared = 100;
        let ordinary = prepared + RESPONSE_ACCEPTANCE_WINDOW_MS;
        assert!(!response_deadline_passed(ordinary - 1, prepared, 200));
        assert!(response_deadline_passed(ordinary, prepared, 200));
        assert!(!response_deadline_passed(ordinary, prepared, ordinary + 1));
        assert!(response_deadline_passed(
            ordinary + 1,
            prepared,
            ordinary + 1
        ));
        assert!(!response_deadline_passed(prepared - 1, prepared, 1));
        assert!(!response_deadline_passed(
            MAX_JS_SAFE_INTEGER,
            MAX_JS_SAFE_INTEGER - 10,
            MAX_JS_SAFE_INTEGER
        ));
    }
}
