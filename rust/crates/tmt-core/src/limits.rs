//! Numeric limits shared by the native parser and runtime.

/// The largest observer timeout, in seconds.
pub const MAX_OBSERVER_TIMEOUT_SECONDS: f64 = 86_400.0;

/// The largest timer delay, in milliseconds.
pub const MAX_TIMER_DELAY_MS: f64 = 2_147_483_647.0;

/// The largest capture count accepted by tmux's line-count argument.
pub const MAX_CAPTURE_LINES: u64 = 2_147_483_647;

/// The largest integer that can be represented exactly by a JavaScript number.
pub const MAX_JS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Returns whether an observer timeout is finite, positive, and within its bound.
pub fn is_valid_observer_timeout_seconds(value: f64) -> bool {
    value.is_finite() && value > 0.0 && value <= MAX_OBSERVER_TIMEOUT_SECONDS
}

/// Returns whether a timer delay is finite, non-negative, and within its bound.
pub fn is_valid_timer_delay_ms(value: f64) -> bool {
    value.is_finite() && (0.0..=MAX_TIMER_DELAY_MS).contains(&value)
}

/// Returns whether a parsed capture-line count is within its bound.
pub fn is_valid_capture_lines(value: u64) -> bool {
    value <= MAX_CAPTURE_LINES
}

/// Returns whether a parsed unsigned integer is within JavaScript's safe range.
pub fn is_valid_js_safe_integer(value: u64) -> bool {
    value <= MAX_JS_SAFE_INTEGER
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_are_the_cross_runtime_boundaries() {
        assert_eq!(MAX_OBSERVER_TIMEOUT_SECONDS, 86_400.0);
        assert_eq!(MAX_TIMER_DELAY_MS, 2_147_483_647.0);
        assert_eq!(MAX_CAPTURE_LINES, 2_147_483_647);
        assert_eq!(MAX_JS_SAFE_INTEGER, 9_007_199_254_740_991);
    }

    #[test]
    fn observer_timeout_accepts_positive_finite_values_at_both_boundaries() {
        assert!(is_valid_observer_timeout_seconds(f64::MIN_POSITIVE));
        assert!(is_valid_observer_timeout_seconds(1.0));
        assert!(is_valid_observer_timeout_seconds(
            MAX_OBSERVER_TIMEOUT_SECONDS
        ));
    }

    #[test]
    fn observer_timeout_rejects_zero_negative_non_finite_and_overflow_values() {
        assert!(!is_valid_observer_timeout_seconds(0.0));
        assert!(!is_valid_observer_timeout_seconds(-0.001));
        assert!(!is_valid_observer_timeout_seconds(-1.0));
        assert!(!is_valid_observer_timeout_seconds(
            MAX_OBSERVER_TIMEOUT_SECONDS + 0.001
        ));
        assert!(!is_valid_observer_timeout_seconds(f64::NAN));
        assert!(!is_valid_observer_timeout_seconds(f64::INFINITY));
        assert!(!is_valid_observer_timeout_seconds(f64::NEG_INFINITY));
    }

    #[test]
    fn timer_delay_accepts_zero_fractional_and_maximum_values() {
        assert!(is_valid_timer_delay_ms(0.0));
        assert!(is_valid_timer_delay_ms(0.5));
        assert!(is_valid_timer_delay_ms(MAX_TIMER_DELAY_MS));
    }

    #[test]
    fn timer_delay_rejects_negative_non_finite_and_overflow_values() {
        assert!(!is_valid_timer_delay_ms(-0.001));
        assert!(!is_valid_timer_delay_ms(-1.0));
        assert!(!is_valid_timer_delay_ms(MAX_TIMER_DELAY_MS + 0.001));
        assert!(!is_valid_timer_delay_ms(f64::NAN));
        assert!(!is_valid_timer_delay_ms(f64::INFINITY));
        assert!(!is_valid_timer_delay_ms(f64::NEG_INFINITY));
    }

    #[test]
    fn capture_lines_accepts_zero_and_maximum_values() {
        assert!(is_valid_capture_lines(0));
        assert!(is_valid_capture_lines(MAX_CAPTURE_LINES));
    }

    #[test]
    fn capture_lines_rejects_values_above_the_signed_32_bit_limit() {
        assert!(!is_valid_capture_lines(MAX_CAPTURE_LINES + 1));
        assert!(!is_valid_capture_lines(u64::MAX));
    }

    #[test]
    fn javascript_safe_integer_accepts_zero_and_exact_maximum() {
        assert!(is_valid_js_safe_integer(0));
        assert!(is_valid_js_safe_integer(MAX_JS_SAFE_INTEGER));
    }

    #[test]
    fn javascript_safe_integer_rejects_values_above_exact_representation_range() {
        assert!(!is_valid_js_safe_integer(MAX_JS_SAFE_INTEGER + 1));
        assert!(!is_valid_js_safe_integer(u64::MAX));
    }
}
