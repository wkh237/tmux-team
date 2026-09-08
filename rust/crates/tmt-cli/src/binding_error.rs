//! Shared CLI error translation; binding policy remains in core.

use crate::output::Failure;
use tmt_adapters::{storage::StorageError, tmux::TmuxError};
use tmt_core::binding::BindingError;

pub fn endpoint_failure(error: TmuxError) -> Failure {
    Failure::new("RECONCILIATION_FAILED", error.to_string(), 1).caused_by(error)
}

pub fn binding_failure(error: BindingError<StorageError, TmuxError>) -> Failure {
    let (code, status) = match &error {
        BindingError::InvalidName(_) => ("INVALID_NAME", 1),
        BindingError::NameNotFound(_) => ("NAME_NOT_FOUND", 3),
        BindingError::PaneNotFound(_) => ("PANE_NOT_FOUND", 3),
        BindingError::NameAlreadyActive => ("NAME_ALREADY_ACTIVE", 5),
        BindingError::PaneAlreadyBound => ("PANE_ALREADY_BOUND", 5),
        BindingError::ConfirmationRequired => ("CONFIRMATION_REQUIRED", 5),
        _ => ("RECONCILIATION_FAILED", 1),
    };
    Failure::new(code, error.to_string(), status).caused_by(error)
}
