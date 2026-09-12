//! Opaque subscriptions to the terminal retirement of an identity UUID.

use std::{error::Error, fmt};

pub const MAX_PENDING_IDENTITY_HOOKS: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookError {
    Consumer,
    Identity,
    Reference,
}

impl fmt::Display for HookError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Consumer => "Invalid identity hook consumer",
            Self::Identity => "Invalid identity hook UUID",
            Self::Reference => "Invalid identity hook reference",
        })
    }
}

impl Error for HookError {}

pub fn valid_hook_consumer(value: &str) -> bool {
    (1..=64).contains(&value.len())
        && value.as_bytes()[0].is_ascii_lowercase()
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityHook {
    consumer: String,
    identity_id: String,
    reference: String,
}

impl IdentityHook {
    pub fn new(consumer: &str, identity_id: &str, reference: &str) -> Result<Self, HookError> {
        if !valid_hook_consumer(consumer) {
            return Err(HookError::Consumer);
        }
        if !uuid::Uuid::parse_str(identity_id).is_ok_and(|id| {
            id.get_version_num() == 4
                && id.get_variant() == uuid::Variant::RFC4122
                && id.to_string() == identity_id
        }) {
            return Err(HookError::Identity);
        }
        if !(1..=256).contains(&reference.len())
            || !reference.bytes().all(|byte| byte.is_ascii_graphic())
        {
            return Err(HookError::Reference);
        }
        Ok(Self {
            consumer: consumer.into(),
            identity_id: identity_id.into(),
            reference: reference.into(),
        })
    }

    pub fn consumer(&self) -> &str {
        &self.consumer
    }
    pub fn identity_id(&self) -> &str {
        &self.identity_id
    }
    pub fn reference(&self) -> &str {
        &self.reference
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityHookState {
    Registered,
    Pending,
    Delivered,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingIdentityHook {
    pub hook: IdentityHook,
    pub attempt_count: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "11111111-1111-4111-8111-111111111111";

    #[test]
    fn hook_bounds_and_uuid_are_validated_without_normalization() {
        assert!(IdentityHook::new("office", ID, "opaque-reference").is_ok());
        for consumer in ["", "Office", "office.name", "1office", &"a".repeat(65)] {
            assert_eq!(
                IdentityHook::new(consumer, ID, "ref"),
                Err(HookError::Consumer)
            );
        }
        for id in [
            "name",
            "11111111-1111-1111-8111-111111111111",
            "AAAAAAAA-1111-4111-8111-111111111111",
        ] {
            assert_eq!(
                IdentityHook::new("office", id, "ref"),
                Err(HookError::Identity)
            );
        }
        for reference in ["", "two words", "\n", "é", &"x".repeat(257)] {
            assert_eq!(
                IdentityHook::new("office", ID, reference),
                Err(HookError::Reference)
            );
        }
        assert!(IdentityHook::new(&"a".repeat(64), ID, &"x".repeat(256)).is_ok());
    }
}
