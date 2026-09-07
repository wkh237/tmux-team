use std::{error::Error, fmt};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorageErrorCode {
    Busy,
    Corrupt,
    Permission,
    IncompatibleSchema,
    Migration,
    Unknown,
    Closed,
}

impl StorageErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Busy => "busy",
            Self::Corrupt => "corrupt",
            Self::Permission => "permission",
            Self::IncompatibleSchema => "incompatible-schema",
            Self::Migration => "migration",
            Self::Unknown => "unknown",
            Self::Closed => "closed",
        }
    }
}

#[derive(Debug)]
pub struct StorageError {
    pub code: StorageErrorCode,
    pub message: String,
    pub migration_version: Option<u32>,
    pub retryable: bool,
    cause: Option<Box<dyn Error + Send + Sync>>,
}

impl StorageError {
    pub(crate) fn new(code: StorageErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            migration_version: None,
            retryable: code == StorageErrorCode::Busy,
            cause: None,
        }
    }

    pub(crate) fn caused_by(mut self, cause: impl Error + Send + Sync + 'static) -> Self {
        self.cause = Some(Box::new(cause));
        self
    }

    pub(crate) fn migration(version: u32, cause: Self) -> Self {
        let retryable = cause.retryable;
        let mut error = Self::new(
            StorageErrorCode::Migration,
            format!("Migration {version} failed"),
        )
        .caused_by(cause);
        error.migration_version = Some(version);
        error.retryable = retryable;
        error
    }
}

impl fmt::Display for StorageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for StorageError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.cause
            .as_deref()
            .map(|cause| cause as &(dyn Error + 'static))
    }
}

pub(crate) fn classify(error: rusqlite::Error, operation: &str) -> StorageError {
    use rusqlite::ErrorCode;
    let code = match error.sqlite_error_code() {
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => StorageErrorCode::Busy,
        Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase) => StorageErrorCode::Corrupt,
        Some(ErrorCode::CannotOpen | ErrorCode::ReadOnly | ErrorCode::PermissionDenied) => {
            StorageErrorCode::Permission
        }
        _ => StorageErrorCode::Unknown,
    };
    StorageError::new(code, format!("{operation} failed")).caused_by(error)
}

pub(crate) fn incompatible(message: impl Into<String>) -> StorageError {
    StorageError::new(StorageErrorCode::IncompatibleSchema, message)
}
