//! Shared failure presentation and close-before-publication ordering.

use crate::invocation::OutputMode;
use std::{
    error::Error,
    fmt,
    io::{self, Write},
};

#[derive(Debug)]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
    pub status: u8,
    cause: Option<Box<dyn Error>>,
}

impl Failure {
    pub fn new(code: &'static str, message: impl Into<String>, status: u8) -> Self {
        Self {
            code,
            message: message.into(),
            status,
            cause: None,
        }
    }

    pub fn caused_by(mut self, cause: impl Error + 'static) -> Self {
        self.cause = Some(Box::new(cause));
        self
    }

    pub fn publish(&self, mode: OutputMode) -> io::Result<u8> {
        if mode.json {
            let document =
                serde_json::json!({"error": {"code": self.code, "message": self.message}});
            writeln!(io::stdout().lock(), "{document}")?;
        } else {
            writeln!(io::stderr().lock(), "{}", self.message)?;
        }
        Ok(self.status)
    }
}

impl fmt::Display for Failure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for Failure {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.cause.as_deref()
    }
}

/// Cleanup runs even when the operation failed. A committed operation is not
/// rolled back by failed cleanup; discard its pending success projection and
/// preserve an existing primary failure, including its status and cause.
pub fn after_cleanup<T, E: Error + 'static>(
    pending: Result<T, Failure>,
    cleanup: impl FnOnce() -> Result<(), E>,
) -> Result<T, Failure> {
    let cleanup = cleanup();
    match pending {
        Err(primary) => Err(primary),
        Ok(report) => cleanup.map(|()| report).map_err(|error| {
            Failure::new(
                "CLEANUP_ERROR",
                "Could not clean up command resources. Effects may already have occurred.",
                1,
            )
            .caused_by(error)
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn cleanup_runs_once_before_a_success_can_be_published() {
        let calls = Cell::new(0);
        let report = after_cleanup(Ok("pending identity"), || {
            calls.set(calls.get() + 1);
            Ok::<_, io::Error>(())
        })
        .unwrap();
        assert_eq!(calls.get(), 1);
        assert_eq!(report, "pending identity");
    }

    #[test]
    fn cleanup_failure_discards_the_success_without_exposing_its_data_or_cause() {
        let failure = after_cleanup(Ok("private identity data"), || {
            Err(io::Error::other("private storage cause"))
        })
        .unwrap_err();
        assert_eq!(failure.code, "CLEANUP_ERROR");
        assert_eq!(failure.status, 1);
        assert!(
            failure
                .message
                .contains("Effects may already have occurred")
        );
        assert!(!failure.message.contains("private"));
        assert_eq!(
            failure.source().unwrap().to_string(),
            "private storage cause"
        );
    }

    #[test]
    fn primary_failure_survives_successful_and_failed_cleanup() {
        for fail_cleanup in [false, true] {
            let calls = Cell::new(0);
            let primary = Failure::new("NAME_NOT_FOUND", "Missing identity", 3)
                .caused_by(io::Error::other("primary cause"));
            let failure = after_cleanup::<(), _>(Err(primary), || {
                calls.set(calls.get() + 1);
                if fail_cleanup {
                    Err(io::Error::other("cleanup cause"))
                } else {
                    Ok(())
                }
            })
            .unwrap_err();
            assert_eq!(calls.get(), 1);
            assert_eq!(failure.code, "NAME_NOT_FOUND");
            assert_eq!(failure.message, "Missing identity");
            assert_eq!(failure.status, 3);
            assert_eq!(failure.source().unwrap().to_string(), "primary cause");
        }
    }
}
