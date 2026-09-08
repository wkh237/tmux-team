//! Identity-scoped attention presentation over the existing request service.

mod presentation;

use crate::{
    identity_context,
    invocation::{ExchangeOperation, OutputMode},
    output::{Failure, after_cleanup},
};
use std::{error::Error, io};
use tmt_adapters::{
    config::ConfigPaths,
    request_runtime::wall_time_ms,
    storage::{Storage, StorageError},
};
use tmt_core::{
    identity::Identity,
    request::{
        RequestError, RequestService,
        attention::{Acknowledged, ExchangeDetail, ExchangePage},
    },
};

enum ResultKind {
    List(ExchangePage),
    Show(ExchangeDetail),
    Ack(Acknowledged),
    Ackall(u64),
}

struct Report {
    identity: Identity,
    result: ResultKind,
}

fn unavailable(error: impl Error + 'static) -> Failure {
    Failure::new("X_ERROR", "Could not complete the exchange operation.", 1).caused_by(error)
}

fn request_failure(error: RequestError<StorageError>) -> Failure {
    let (code, status) = match &error {
        RequestError::Attention(reason) => (
            reason.code(),
            match reason {
                tmt_core::request::attention::AttentionRejection::NotFound => 3,
                tmt_core::request::attention::AttentionRejection::RevisionConflict { .. } => 5,
                _ => 1,
            },
        ),
        RequestError::RevisionExhausted => ("X_REVISION_EXHAUSTED", 1),
        _ => return unavailable(error),
    };
    Failure::new(code, error.to_string(), status).caused_by(error)
}

fn run(identity: Option<String>, operation: ExchangeOperation) -> Result<Report, Failure> {
    let paths = ConfigPaths::discover().map_err(unavailable)?;
    let mut storage = Storage::open(paths.database).map_err(unavailable)?;
    let pending = (|| {
        let identity =
            identity_context::resolve(&mut storage, identity.as_deref()).map_err(|error| {
                if error.code == "IDENTITY_ERROR" {
                    unavailable(error)
                } else {
                    error
                }
            })?;
        let mut service = RequestService::new(&mut storage, wall_time_ms);
        let result = match operation {
            ExchangeOperation::List { limit, after } => service
                .list_exchanges(&identity.id, limit, after)
                .map(ResultKind::List),
            ExchangeOperation::Show(request) => service
                .show_exchange(&identity.id, &request)
                .map(ResultKind::Show),
            ExchangeOperation::Ack {
                request_id,
                revision,
            } => service
                .acknowledge_exchange(&identity.id, &request_id, revision)
                .map(ResultKind::Ack),
            ExchangeOperation::Ackall => service
                .acknowledge_all_exchanges(&identity.id)
                .map(ResultKind::Ackall),
        }
        .map_err(request_failure)?;
        Ok(Report { identity, result })
    })();
    after_cleanup(pending, || storage.close())
}

pub fn execute(
    identity: Option<String>,
    operation: ExchangeOperation,
    mode: OutputMode,
) -> io::Result<u8> {
    match run(identity, operation) {
        Ok(report) => presentation::publish(report, mode),
        Err(error) => error.publish(mode),
    }
}
