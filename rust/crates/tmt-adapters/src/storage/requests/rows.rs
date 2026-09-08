//! Strict SQLite row decoding for request state.

use rusqlite::Row;
use tmt_core::{
    endpoint::ServerEvidence,
    limits::is_valid_js_safe_integer,
    request::{
        AttemptStatus, FinalResponse, Originator, RawRequestContext, RequestAttempt,
        RequestEndpoint,
        attention::{AttentionRecord, ResponseMetadata},
    },
};

pub(super) const ATTEMPT_COLUMNS: &str = "
    attempt_id, request_id, originator_kind, originator_identity_id,
    recipient_identity_id, nonce, identity_id, server_id, socket_path,
    server_pid, server_start_time, pane_id, pane_pid, wait_active, status,
    preamble_every, inject_preamble, cadence_reserved, prepared_at_ms,
    sending_at_ms, settled_at_ms, wait_released_at_ms, response_submitted_at_ms,
    expires_at_ms, retention_days, retention_expires_at_ms,
    attention_revision, attention_acknowledged_revision";
pub(super) const RESPONSE_COLUMNS: &str = "
    request_id, attempt_id, server_id, socket_path, server_pid, server_start_time,
    pane_id, pane_pid, body, body_bytes, submitted_at_ms, response_expires_at_ms";

fn invalid_row() -> rusqlite::Error {
    rusqlite::Error::InvalidQuery
}

fn checked_u64(value: i64) -> rusqlite::Result<u64> {
    let value = u64::try_from(value).map_err(|_| invalid_row())?;
    if !is_valid_js_safe_integer(value) {
        Err(invalid_row())
    } else {
        Ok(value)
    }
}

pub(super) fn u64_at(row: &Row<'_>, offset: usize) -> rusqlite::Result<u64> {
    checked_u64(row.get(offset)?)
}

fn optional_u64_at(row: &Row<'_>, offset: usize) -> rusqlite::Result<Option<u64>> {
    row.get::<_, Option<i64>>(offset)?
        .map(checked_u64)
        .transpose()
}

fn bool_at(row: &Row<'_>, offset: usize) -> rusqlite::Result<bool> {
    match row.get::<_, i64>(offset)? {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(invalid_row()),
    }
}

fn status_at(row: &Row<'_>, offset: usize) -> rusqlite::Result<AttemptStatus> {
    match row.get::<_, String>(offset)?.as_str() {
        "prepared" => Ok(AttemptStatus::Prepared),
        "sending" => Ok(AttemptStatus::Sending),
        "sent" => Ok(AttemptStatus::Sent),
        "uncertain" => Ok(AttemptStatus::Uncertain),
        "definitely_failed" => Ok(AttemptStatus::DefinitelyFailed),
        _ => Err(invalid_row()),
    }
}

pub(super) fn attempt_row(row: &Row<'_>) -> rusqlite::Result<RequestAttempt> {
    let originator_kind = row.get::<_, String>(2)?;
    let originator_identity_id = row.get::<_, Option<String>>(3)?;
    let originator = match originator_kind.as_str() {
        "unknown" if originator_identity_id.is_none() => Originator::Unknown,
        "explicit" => Originator::Explicit(originator_identity_id.ok_or_else(invalid_row)?),
        "verified" => Originator::Verified(originator_identity_id.ok_or_else(invalid_row)?),
        _ => return Err(invalid_row()),
    };
    let server_pid = u64_at(row, 9)?;
    let pane_pid = u64_at(row, 12)?;
    if server_pid == 0 || pane_pid == 0 {
        return Err(invalid_row());
    }
    let attention_revision = u64_at(row, 26)?;
    let attention_acknowledged_revision = u64_at(row, 27)?;
    if attention_acknowledged_revision > attention_revision {
        return Err(invalid_row());
    }
    let preamble_every = optional_u64_at(row, 15)?;
    if preamble_every == Some(0) {
        return Err(invalid_row());
    }
    Ok(RequestAttempt {
        attempt_id: row.get(0)?,
        request_id: row.get(1)?,
        originator,
        recipient_identity_id: row.get(4)?,
        nonce: row.get(5)?,
        identity_id: row.get(6)?,
        endpoint: RequestEndpoint {
            server: ServerEvidence {
                server_id: row.get(7)?,
                socket_path: row.get(8)?,
                server_pid,
                server_start_time: row.get(10)?,
            },
            pane_id: row.get(11)?,
            pane_pid,
        },
        wait_active: bool_at(row, 13)?,
        status: status_at(row, 14)?,
        preamble_every,
        inject_preamble: bool_at(row, 16)?,
        cadence_reserved: bool_at(row, 17)?,
        prepared_at_ms: u64_at(row, 18)?,
        sending_at_ms: optional_u64_at(row, 19)?,
        settled_at_ms: optional_u64_at(row, 20)?,
        wait_released_at_ms: optional_u64_at(row, 21)?,
        response_submitted_at_ms: optional_u64_at(row, 22)?,
        expires_at_ms: u64_at(row, 23)?,
        retention_days: u64_at(row, 24)?,
        retention_expires_at_ms: u64_at(row, 25)?,
    })
}

pub(super) fn response_row(row: &Row<'_>) -> rusqlite::Result<FinalResponse> {
    let server_pid = u64_at(row, 4)?;
    let pane_pid = u64_at(row, 7)?;
    if server_pid == 0 || pane_pid == 0 {
        return Err(invalid_row());
    }
    Ok(FinalResponse {
        request_id: row.get(0)?,
        attempt_id: row.get(1)?,
        endpoint: RequestEndpoint {
            server: ServerEvidence {
                server_id: row.get(2)?,
                socket_path: row.get(3)?,
                server_pid,
                server_start_time: row.get(5)?,
            },
            pane_id: row.get(6)?,
            pane_pid,
        },
        body: row.get(8)?,
        body_bytes: u64_at(row, 9)?,
        submitted_at_ms: u64_at(row, 10)?,
        response_expires_at_ms: u64_at(row, 11)?,
    })
}

pub(super) fn attention_row(row: &Row<'_>) -> rusqlite::Result<AttentionRecord> {
    let revision = u64_at(row, 26)?;
    let acknowledged_revision = u64_at(row, 27)?;
    let attempt = attempt_row(row)?;
    let acknowledged_through = u64_at(row, 28)?;
    let submitted_at_ms = optional_u64_at(row, 29)?;
    let body_bytes = optional_u64_at(row, 30)?;
    let expires_at_ms = optional_u64_at(row, 31)?;
    let response_metadata = match (submitted_at_ms, body_bytes, expires_at_ms) {
        (None, None, None) => None,
        (Some(_), Some(body_bytes), Some(expires_at_ms)) => Some(ResponseMetadata {
            body_bytes,
            expires_at_ms,
        }),
        _ => return Err(invalid_row()),
    };
    Ok(AttentionRecord {
        attempt,
        revision,
        acknowledged_revision,
        acknowledged_through,
        response_metadata,
    })
}

pub(super) fn context_row(row: &Row<'_>) -> rusqlite::Result<RawRequestContext> {
    let attempt = attempt_row(row)?;
    let message: Option<String> = row.get(28)?;
    let message_bytes = optional_u64_at(row, 29)?;
    let expires_at_ms = optional_u64_at(row, 30)?;
    // Prompt scrubbing removes text and byte count but intentionally retains
    // the expiry marker, allowing reads to distinguish expired from historical
    // content that was never stored.
    if message.is_some() != message_bytes.is_some()
        || (message.is_some() && expires_at_ms.is_none())
    {
        return Err(invalid_row());
    }
    Ok(RawRequestContext {
        attempt,
        message,
        message_bytes,
        expires_at_ms,
    })
}
