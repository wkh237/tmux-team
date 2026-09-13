//! Thin local Office protocol over the shared SQLite repository.

use serde::Deserialize;
use serde_json::{Value, json};
use tmt_core::office_protocol::{OfficeError, OfficeInvocation};

use crate::{
    config::ConfigPaths,
    office_block::{LayoutInput, layout_value},
    storage::{LocalBlockSnapshot, LocalOfficeError, Storage},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalBlockInput {
    identity_id: String,
    #[serde(default)]
    layout: Option<LayoutInput>,
    #[serde(default)]
    expected_revision: Option<u64>,
}

pub fn execute(operation: OfficeInvocation, input: &[u8]) -> Vec<u8> {
    serde_json::to_vec(
        &execute_inner(operation, input).unwrap_or_else(|error| json!({"error": error.code()})),
    )
    .unwrap_or_else(|_| br#"{"error":"OFFICE_CREDENTIALS_INVALID"}"#.to_vec())
}

fn execute_inner(operation: OfficeInvocation, input: &[u8]) -> Result<Value, OfficeError> {
    if input.len() > 4096 {
        return Err(OfficeError::LayoutInvalid);
    }
    let input: LocalBlockInput =
        serde_json::from_slice(input).map_err(|_| OfficeError::LayoutInvalid)?;
    let paths = ConfigPaths::discover().map_err(|_| OfficeError::CredentialsUnavailable)?;
    let mut storage = Storage::open(paths.database).map_err(storage_error)?;
    let result = match operation {
        OfficeInvocation::LocalBlockShow
            if input.layout.is_none() && input.expected_revision.is_none() =>
        {
            storage
                .show_local_block(&input.identity_id)
                .map(local_snapshot)
                .map_err(local_error)
        }
        OfficeInvocation::LocalBlockApply => {
            let layout = input.layout.ok_or(OfficeError::LayoutInvalid)?.validate()?;
            let revision = input
                .expected_revision
                .filter(|revision| *revision < tmt_core::office_block::MAX_REVISION)
                .ok_or(OfficeError::LayoutInvalid)?;
            storage
                .apply_local_block(&input.identity_id, revision, &layout)
                .map(local_snapshot)
                .map_err(local_error)
        }
        _ => Err(OfficeError::CredentialsInvalid),
    };
    let close = storage.close().map_err(storage_error);
    match (result, close) {
        (Err(error), _) => Err(error),
        (Ok(value), Ok(())) => Ok(value),
        (Ok(_), Err(error)) => Err(error),
    }
}

pub fn local_snapshot(snapshot: LocalBlockSnapshot) -> Value {
    let mut value = layout_value(&snapshot.layout);
    value["exists"] = json!(snapshot.exists());
    value["identityId"] = json!(snapshot.identity_id);
    value["identityName"] = json!(snapshot.identity_name);
    value["blockId"] = snapshot.block_id.map_or(Value::Null, Value::String);
    value["revision"] = json!(snapshot.revision);
    value["updatedAtMs"] = json!(snapshot.updated_at_ms);
    value
}

fn local_error(error: LocalOfficeError) -> OfficeError {
    match error {
        LocalOfficeError::IdentityInactive => OfficeError::IdentityInactive,
        LocalOfficeError::RevisionConflict | LocalOfficeError::RevisionExhausted => {
            OfficeError::RevisionConflict
        }
        LocalOfficeError::StoredLayoutInvalid => OfficeError::CredentialsInvalid,
        LocalOfficeError::Storage(error) => storage_error(error),
    }
}

fn storage_error(error: impl std::error::Error) -> OfficeError {
    let _ = error;
    OfficeError::CredentialsUnavailable
}
