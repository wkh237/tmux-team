//! Runtime entropy and wall-clock sampling for the existing request service.

use std::time::{SystemTime, UNIX_EPOCH};

/// Invalid clocks fail closed through the service's safe-integer validation.
pub fn wall_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|time| u64::try_from(time.as_millis()).ok())
        .unwrap_or(0)
}

pub fn request_ids() -> (String, String) {
    (
        format!("req_{}", uuid::Uuid::new_v4()),
        uuid::Uuid::new_v4().to_string(),
    )
}
