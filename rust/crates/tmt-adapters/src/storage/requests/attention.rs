//! SQL projections and guarded mutations for retained request attention.

use rusqlite::{Connection, OptionalExtension, params};
use tmt_core::request::attention::AttentionRecord;

use super::{checked_i64, checked_limit, checked_now, rows};
use crate::storage::{StorageError, errors::classify};

use rows::qualified_attempt_columns;

fn attention_select_from(source: &str, where_clause: &str) -> String {
    format!(
        "SELECT {},
                state.acknowledged_through,
                response.submitted_at_ms AS response_metadata_submitted_at_ms,
                response.body_bytes AS response_metadata_body_bytes,
                response.response_expires_at_ms AS response_metadata_expires_at_ms
         FROM {source}
         JOIN request_attention_identities AS state
           ON state.identity_id = a.originator_identity_id
         LEFT JOIN request_responses AS response
           ON response.request_id = a.request_id
         WHERE {where_clause}",
        qualified_attempt_columns(),
    )
}

fn attention_select(where_clause: &str) -> String {
    attention_select_from("request_attempts AS a", where_clause)
}

pub(super) fn find_attention(
    connection: &Connection,
    identity_id: &str,
    request_id: &str,
) -> Result<Option<AttentionRecord>, StorageError> {
    connection
        .query_row(
            &attention_select(
                "a.originator_identity_id = ?
                 AND a.request_id = ?
                 AND a.attention_revision > 0",
            ),
            params![identity_id, request_id],
            rows::attention_row,
        )
        .optional()
        .map_err(|error| classify(error, "Find request attention"))
}

pub(super) fn list_attention(
    connection: &Connection,
    identity_id: &str,
    after: u64,
    limit: u64,
    now_ms: u64,
) -> Result<Vec<AttentionRecord>, StorageError> {
    let query = format!(
        "{}\n         ORDER BY a.attention_revision, a.request_id\n         LIMIT ?",
        attention_select(
            "a.originator_identity_id = ?
             AND a.attention_revision > 0
             AND a.attention_revision > ?
             AND a.retention_expires_at_ms > ?
             AND a.attention_acknowledged_revision < a.attention_revision
             AND state.acknowledged_through < a.attention_revision",
        ),
    );
    let mut statement = connection
        .prepare(&query)
        .map_err(|error| classify(error, "Prepare request attention query"))?;
    let records = statement
        .query_map(
            params![
                identity_id,
                checked_i64(after, "Attention cursor")?,
                checked_now(now_ms, "Attention retention cutoff")?,
                checked_limit(limit)?
            ],
            rows::attention_row,
        )
        .map_err(|error| classify(error, "List request attention"))?;
    records
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| classify(error, "Decode request attention"))
}

pub(super) fn list_response_attention(
    connection: &Connection,
    identity_id: &str,
    room_id: Option<&str>,
    after: u64,
    limit: u64,
    now_ms: u64,
) -> Result<Vec<AttentionRecord>, StorageError> {
    let source = if room_id.is_some() {
        "request_attempts AS a INDEXED BY request_attempts_room_response_attention"
    } else {
        "request_attempts AS a INDEXED BY request_attempts_response_attention"
    };
    let scope = if room_id.is_some() {
        "a.room_id = ?4"
    } else {
        "?4 IS NULL"
    };
    let query = format!(
        "{}\n         ORDER BY a.attention_revision, a.request_id\n         LIMIT ?5",
        attention_select_from(
            source,
            &format!(
                "a.originator_identity_id = ?1
             AND a.response_submitted_at_ms IS NOT NULL
             AND a.attention_revision > ?2
             AND a.retention_expires_at_ms > ?3
             AND {scope}
             AND a.attention_acknowledged_revision < a.attention_revision
             AND state.acknowledged_through < a.attention_revision"
            ),
        ),
    );
    let mut statement = connection
        .prepare(&query)
        .map_err(|error| classify(error, "Prepare response attention query"))?;
    let records = statement
        .query_map(
            params![
                identity_id,
                checked_i64(after, "Response attention cursor")?,
                checked_now(now_ms, "Response attention retention cutoff")?,
                room_id,
                checked_limit(limit)?
            ],
            rows::attention_row,
        )
        .map_err(|error| classify(error, "List response attention"))?;
    records
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| classify(error, "Decode response attention"))
}

pub(super) fn acknowledge_revision(
    connection: &Connection,
    identity_id: &str,
    request_id: &str,
    revision: u64,
) -> Result<bool, StorageError> {
    let revision = checked_i64(revision, "Attention revision")?;
    let changed = connection
        .execute(
            "UPDATE request_attempts
             SET attention_acknowledged_revision = ?
             WHERE originator_identity_id = ?
               AND request_id = ?
               AND attention_revision = ?
               AND attention_acknowledged_revision < ?",
            params![revision, identity_id, request_id, revision, revision],
        )
        .map_err(|error| classify(error, "Acknowledge request attention"))?;
    Ok(changed == 1)
}

pub(super) fn acknowledge_through(
    connection: &Connection,
    identity_id: &str,
    latest: u64,
) -> Result<bool, StorageError> {
    let latest = checked_i64(latest, "Latest attention revision")?;
    let changed = connection
        .execute(
            "UPDATE request_attention_identities
             SET acknowledged_through = MAX(acknowledged_through, ?)
             WHERE identity_id = ? AND latest_revision = ?",
            params![latest, identity_id, latest],
        )
        .map_err(|error| classify(error, "Acknowledge attention through"))?;
    Ok(changed == 1)
}

fn recipient_attention_select(source: &str, where_clause: &str) -> String {
    format!(
        "SELECT {}, state.acknowledged_through,
                response.submitted_at_ms, response.body_bytes, response.response_expires_at_ms
         FROM {source}
         JOIN request_recipient_attention_identities AS state ON state.identity_id = a.recipient_identity_id
         LEFT JOIN request_responses AS response ON response.request_id = a.request_id
         WHERE {where_clause}", qualified_attempt_columns())
}

pub(super) fn find_recipient_attention(
    connection: &Connection,
    identity_id: &str,
    request_id: &str,
) -> Result<Option<AttentionRecord>, StorageError> {
    connection
        .query_row(
            &recipient_attention_select(
                "request_attempts AS a",
                "a.route_kind = 'inbox' AND a.status = 'queued'
             AND a.recipient_identity_id = ? AND a.request_id = ?
             AND a.recipient_attention_revision > 0",
            ),
            params![identity_id, request_id],
            rows::recipient_attention_row,
        )
        .optional()
        .map_err(|error| classify(error, "Find recipient request attention"))
}

pub(super) fn list_recipient_attention(
    connection: &Connection,
    identity_id: &str,
    room_id: Option<&str>,
    after: u64,
    limit: u64,
    now_ms: u64,
) -> Result<Vec<AttentionRecord>, StorageError> {
    let source = if room_id.is_some() {
        "request_attempts AS a INDEXED BY request_attempts_room_recipient_attention"
    } else {
        "request_attempts AS a INDEXED BY request_attempts_recipient_attention"
    };
    let scope = if room_id.is_some() {
        "a.room_id = ?4"
    } else {
        "?4 IS NULL"
    };
    let query = format!(
        "{} ORDER BY a.recipient_attention_revision, a.request_id LIMIT ?5",
        recipient_attention_select(
            source,
            &format!(
                "a.route_kind = 'inbox' AND a.status = 'queued'
             AND a.recipient_identity_id = ?1 AND a.recipient_attention_revision > ?2
             AND a.retention_expires_at_ms > ?3
             AND {scope}
             AND a.recipient_attention_acknowledged_revision < a.recipient_attention_revision
             AND state.acknowledged_through < a.recipient_attention_revision"
            )
        )
    );
    let mut statement = connection
        .prepare(&query)
        .map_err(|error| classify(error, "Prepare recipient attention query"))?;
    let records = statement
        .query_map(
            params![
                identity_id,
                checked_i64(after, "Recipient attention cursor")?,
                checked_now(now_ms, "Recipient attention retention cutoff")?,
                room_id,
                checked_limit(limit)?
            ],
            rows::recipient_attention_row,
        )
        .map_err(|error| classify(error, "List recipient attention"))?;
    records
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|error| classify(error, "Decode recipient attention"))
}

pub(super) fn acknowledge_recipient_revision(
    connection: &Connection,
    identity_id: &str,
    request_id: &str,
    revision: u64,
) -> Result<bool, StorageError> {
    let revision = checked_i64(revision, "Recipient attention revision")?;
    let changed = connection
        .execute(
            "UPDATE request_attempts SET recipient_attention_acknowledged_revision = ?
         WHERE recipient_identity_id = ? AND request_id = ? AND recipient_attention_revision = ?
           AND recipient_attention_acknowledged_revision < ?",
            params![revision, identity_id, request_id, revision, revision],
        )
        .map_err(|error| classify(error, "Acknowledge recipient attention"))?;
    Ok(changed == 1)
}

pub(super) fn acknowledge_recipient_through(
    connection: &Connection,
    identity_id: &str,
    latest: u64,
) -> Result<bool, StorageError> {
    let latest = checked_i64(latest, "Latest recipient attention revision")?;
    let changed = connection.execute(
        "UPDATE request_recipient_attention_identities SET acknowledged_through = MAX(acknowledged_through, ?)
         WHERE identity_id = ? AND latest_revision = ?",
        params![latest, identity_id, latest],
    ).map_err(|error| classify(error, "Acknowledge recipient attention through"))?;
    Ok(changed == 1)
}
