//! Short-lived self-reported activity, separate from presence and request state.

use crate::limits::MAX_JS_SAFE_INTEGER;
use std::{error::Error, fmt};

pub const MAX_ACTIVITY_BYTES: usize = 160;
pub const MAX_MOOD_BYTES: usize = 32;
pub const DEFAULT_STATUS_TTL_MS: u64 = 3_600_000;
pub const MIN_STATUS_TTL_MS: u64 = 1_000;
pub const MAX_STATUS_TTL_MS: u64 = 86_400_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityStatus {
    pub activity: String,
    pub mood: Option<String>,
    pub updated_at_ms: u64,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusInvalid {
    Activity,
    Mood,
    Duration,
    Clock,
}

impl fmt::Display for StatusInvalid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Activity => {
                "Status activity must contain 1-160 UTF-8 bytes of nonblank text without controls."
            }
            Self::Mood => {
                "Status mood must contain 1-32 UTF-8 bytes of nonblank text without controls."
            }
            Self::Duration => "Status duration must be 1 second through 24 hours.",
            Self::Clock => "Status timestamps must be positive safe integers with a valid expiry.",
        })
    }
}
impl Error for StatusInvalid {}

impl IdentityStatus {
    pub fn new(
        activity: String,
        mood: Option<String>,
        now_ms: u64,
        ttl_ms: u64,
    ) -> Result<Self, StatusInvalid> {
        if !(MIN_STATUS_TTL_MS..=MAX_STATUS_TTL_MS).contains(&ttl_ms) {
            return Err(StatusInvalid::Duration);
        }
        let expires_at_ms = now_ms.checked_add(ttl_ms).ok_or(StatusInvalid::Clock)?;
        let status = Self {
            activity,
            mood,
            updated_at_ms: now_ms,
            expires_at_ms,
        };
        status.validate()?;
        Ok(status)
    }

    pub fn validate(&self) -> Result<(), StatusInvalid> {
        let text = |value: &str, limit: usize| {
            !value.trim().is_empty() && value.len() <= limit && !value.chars().any(char::is_control)
        };
        if !text(&self.activity, MAX_ACTIVITY_BYTES) {
            return Err(StatusInvalid::Activity);
        }
        if self
            .mood
            .as_deref()
            .is_some_and(|mood| !text(mood, MAX_MOOD_BYTES))
        {
            return Err(StatusInvalid::Mood);
        }
        if self.updated_at_ms == 0
            || self.expires_at_ms > MAX_JS_SAFE_INTEGER
            || self
                .expires_at_ms
                .checked_sub(self.updated_at_ms)
                .is_none_or(|ttl| !(MIN_STATUS_TTL_MS..=MAX_STATUS_TTL_MS).contains(&ttl))
        {
            return Err(StatusInvalid::Clock);
        }
        Ok(())
    }

    pub fn is_stale(&self, now_ms: u64) -> bool {
        now_ms < self.updated_at_ms || now_ms >= self.expires_at_ms
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StatusLookup {
    IdentityInactive,
    Found(Option<IdentityStatus>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusClear {
    IdentityInactive,
    Cleared { removed: bool },
}

/// Mutations revalidate active identity UUIDs in the same transaction as the write.
pub trait IdentityStatusRepository {
    type Error;
    fn read_identity_status(&self, identity_id: &str) -> Result<StatusLookup, Self::Error>;
    fn write_identity_status(
        &mut self,
        identity_id: &str,
        status: &IdentityStatus,
    ) -> Result<bool, Self::Error>;
    fn clear_identity_status(&mut self, identity_id: &str) -> Result<StatusClear, Self::Error>;
}

#[derive(Debug)]
pub enum StatusError<E> {
    Invalid(StatusInvalid),
    IdentityInactive,
    Repository(E),
}

pub fn show_identity_status<R: IdentityStatusRepository>(
    repository: &R,
    identity_id: &str,
) -> Result<Option<IdentityStatus>, StatusError<R::Error>> {
    match repository
        .read_identity_status(identity_id)
        .map_err(StatusError::Repository)?
    {
        StatusLookup::IdentityInactive => Err(StatusError::IdentityInactive),
        StatusLookup::Found(status) => Ok(status),
    }
}

pub fn set_identity_status<R: IdentityStatusRepository>(
    repository: &mut R,
    identity_id: &str,
    activity: String,
    mood: Option<String>,
    now_ms: u64,
    ttl_ms: u64,
) -> Result<IdentityStatus, StatusError<R::Error>> {
    let status =
        IdentityStatus::new(activity, mood, now_ms, ttl_ms).map_err(StatusError::Invalid)?;
    if !repository
        .write_identity_status(identity_id, &status)
        .map_err(StatusError::Repository)?
    {
        return Err(StatusError::IdentityInactive);
    }
    Ok(status)
}

pub fn clear_identity_status<R: IdentityStatusRepository>(
    repository: &mut R,
    identity_id: &str,
) -> Result<bool, StatusError<R::Error>> {
    match repository
        .clear_identity_status(identity_id)
        .map_err(StatusError::Repository)?
    {
        StatusClear::IdentityInactive => Err(StatusError::IdentityInactive),
        StatusClear::Cleared { removed } => Ok(removed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_utf8_controls_duration_and_safe_timestamps() {
        let valid = || {
            IdentityStatus::new("é".repeat(80), Some("é".repeat(16)), 1, MIN_STATUS_TTL_MS).unwrap()
        };
        assert_eq!(valid().validate(), Ok(()));
        for activity in [" ".into(), "a\nb".into(), "é".repeat(81)] {
            assert_eq!(
                IdentityStatus::new(activity, None, 1, 1000),
                Err(StatusInvalid::Activity)
            );
        }
        for mood in [" ".into(), "x\ty".into(), "é".repeat(17)] {
            assert_eq!(
                IdentityStatus::new("Work".into(), Some(mood), 1, 1000),
                Err(StatusInvalid::Mood)
            );
        }
        for ttl in [0, 999, MAX_STATUS_TTL_MS + 1] {
            assert_eq!(
                IdentityStatus::new("Work".into(), None, 1, ttl),
                Err(StatusInvalid::Duration)
            );
        }
        for now in [0, MAX_JS_SAFE_INTEGER, u64::MAX] {
            assert_eq!(
                IdentityStatus::new("Work".into(), None, now, 1000),
                Err(StatusInvalid::Clock)
            );
        }
        assert!(
            IdentityStatus::new(
                "Work".into(),
                None,
                MAX_JS_SAFE_INTEGER - MAX_STATUS_TTL_MS,
                MAX_STATUS_TTL_MS
            )
            .is_ok()
        );
    }

    #[test]
    fn expiry_and_clock_rollback_are_read_only_stale_boundaries() {
        let status = IdentityStatus::new("Reviewing".into(), None, 100, 1000).unwrap();
        assert!(status.is_stale(99));
        assert!(!status.is_stale(100));
        assert!(!status.is_stale(1099));
        assert!(status.is_stale(1100));
        assert_eq!(status.updated_at_ms, 100);
        assert_eq!(status.activity, "Reviewing");
    }

    #[test]
    fn blankness_uses_unicode_white_space_not_ecmascript_bom_trimming() {
        assert!(
            IdentityStatus::new("\u{feff}".into(), Some(" \u{feff} ".into()), 100, 1000).is_ok()
        );
        assert_eq!(
            IdentityStatus::new("\u{2003}\u{3000}".into(), None, 100, 1000),
            Err(StatusInvalid::Activity)
        );
    }
}
