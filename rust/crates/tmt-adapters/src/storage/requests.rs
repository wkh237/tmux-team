//! SQLite-backed durable request state.
//!
//! Request policy stays in `tmt-core`; this module only decodes rows and applies
//! the bounded SQL mutations while the invocation-owned immediate transaction is
//! held.

mod rows;

use rusqlite::{Connection, OptionalExtension, params};
use tmt_core::request::{
    AttemptStatus, FinalResponse, RawRequestContext, RequestAttempt, RequestEndpoint,
    RequestRecords, RequestRepository, StoredPrompt,
};

use super::{
    Storage, StorageError, StorageErrorCode, errors::classify,
    identities::with_immediate_transaction,
};

struct RequestRows<'a>(&'a Connection);

const DELETE_RETAINED_SQL: &str = "DELETE FROM request_attempts
             WHERE attempt_id IN (
                 SELECT attempt_id
                 FROM request_attempts INDEXED BY request_attempts_retention_horizon
                 WHERE wait_active = 0
                   AND status IN ('sent', 'uncertain', 'definitely_failed')
                   AND settled_at_ms IS NOT NULL
                   AND settled_at_ms <= ?
                   AND retention_expires_at_ms <= ?
                   AND NOT EXISTS (
                       SELECT 1 FROM request_responses
                       WHERE request_responses.attempt_id = request_attempts.attempt_id
                         AND request_responses.response_expires_at_ms > ?
                   )
                 ORDER BY retention_expires_at_ms, attempt_id
                 LIMIT ?
             )";

fn endpoint_args(endpoint: &RequestEndpoint) -> Result<[rusqlite::types::Value; 6], StorageError> {
    Ok([
        endpoint.server.server_id.clone().into(),
        endpoint.server.socket_path.clone().into(),
        checked_i64(endpoint.server.server_pid, "Server PID")?.into(),
        endpoint.server.server_start_time.clone().into(),
        endpoint.pane_id.clone().into(),
        checked_i64(endpoint.pane_pid, "Pane PID")?.into(),
    ])
}

fn checked_i64(value: u64, label: &str) -> Result<i64, StorageError> {
    i64::try_from(value).map_err(|_| {
        StorageError::new(
            StorageErrorCode::Unknown,
            format!("{label} is outside the supported range"),
        )
    })
}

fn checked_limit(value: u64) -> Result<i64, StorageError> {
    checked_i64(value, "Cleanup batch limit").and_then(|value| {
        if value > 0 {
            Ok(value)
        } else {
            Err(StorageError::new(
                StorageErrorCode::Unknown,
                "Cleanup batch limit must be positive",
            ))
        }
    })
}

fn checked_now(value: u64, label: &str) -> Result<i64, StorageError> {
    checked_i64(value, label).and_then(|value| {
        if value > 0 {
            Ok(value)
        } else {
            Err(StorageError::new(
                StorageErrorCode::Unknown,
                format!("{label} is outside the supported range"),
            ))
        }
    })
}

impl RequestRecords for RequestRows<'_> {
    type Error = StorageError;

    fn find_attempt(&self, attempt_id: &str) -> Result<Option<RequestAttempt>, Self::Error> {
        self.0
            .query_row(
                &format!(
                    "SELECT {} FROM request_attempts WHERE attempt_id = ?",
                    rows::ATTEMPT_COLUMNS
                ),
                [attempt_id],
                rows::attempt_row,
            )
            .optional()
            .map_err(|error| classify(error, "Find request attempt"))
    }

    fn find_request(&self, request_id: &str) -> Result<Option<RequestAttempt>, Self::Error> {
        self.0
            .query_row(
                &format!(
                    "SELECT {} FROM request_attempts WHERE request_id = ?",
                    rows::ATTEMPT_COLUMNS
                ),
                [request_id],
                rows::attempt_row,
            )
            .optional()
            .map_err(|error| classify(error, "Find request"))
    }

    fn find_context(&self, request_id: &str) -> Result<Option<RawRequestContext>, Self::Error> {
        self.0
            .query_row(
                &format!(
                    "SELECT {}, message_text, message_bytes, message_expires_at_ms
                     FROM request_attempts WHERE request_id = ?",
                    rows::ATTEMPT_COLUMNS
                ),
                [request_id],
                rows::context_row,
            )
            .optional()
            .map_err(|error| classify(error, "Find request context"))
    }

    fn find_response(&self, request_id: &str) -> Result<Option<FinalResponse>, Self::Error> {
        self.0
            .query_row(
                &format!(
                    "SELECT {} FROM request_responses WHERE request_id = ?",
                    rows::RESPONSE_COLUMNS
                ),
                [request_id],
                rows::response_row,
            )
            .optional()
            .map_err(|error| classify(error, "Find request response"))
    }

    fn find_active_request(
        &self,
        endpoint: &RequestEndpoint,
    ) -> Result<Option<String>, Self::Error> {
        let args = endpoint_args(endpoint)?;
        self.0
            .query_row(
                "SELECT request_id FROM request_attempts
             WHERE server_id = ? AND socket_path = ? AND server_pid = ?
               AND server_start_time = ? AND pane_id = ? AND pane_pid = ?
               AND wait_active = 1
             ORDER BY prepared_at_ms, attempt_id LIMIT 1",
                rusqlite::params_from_iter(args),
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| classify(error, "Find active request"))
    }

    fn create_attempt(
        &mut self,
        attempt: &RequestAttempt,
        prompt: &StoredPrompt,
        revision: u64,
    ) -> Result<(), Self::Error> {
        let server_pid = checked_i64(attempt.endpoint.server.server_pid, "Server PID")?;
        let pane_pid = checked_i64(attempt.endpoint.pane_pid, "Pane PID")?;
        let preamble_every = attempt
            .preamble_every
            .map(|value| checked_i64(value, "Preamble cadence"))
            .transpose()?;
        let sending_at_ms = attempt
            .sending_at_ms
            .map(|value| checked_i64(value, "Sending timestamp"))
            .transpose()?;
        let settled_at_ms = attempt
            .settled_at_ms
            .map(|value| checked_i64(value, "Settlement timestamp"))
            .transpose()?;
        let wait_released_at_ms = attempt
            .wait_released_at_ms
            .map(|value| checked_i64(value, "Wait release timestamp"))
            .transpose()?;
        let response_submitted_at_ms = attempt
            .response_submitted_at_ms
            .map(|value| checked_i64(value, "Response timestamp"))
            .transpose()?;
        let prepared_at_ms = checked_i64(attempt.prepared_at_ms, "Preparation timestamp")?;
        let expires_at_ms = checked_i64(attempt.expires_at_ms, "Expiry timestamp")?;
        let retention_days = checked_i64(attempt.retention_days, "Retention days")?;
        let retention_expires_at_ms = checked_i64(
            attempt.retention_expires_at_ms,
            "Retention expiry timestamp",
        )?;
        let revision = checked_i64(revision, "Attention revision")?;
        let prompt_bytes = checked_i64(prompt.message_bytes, "Prompt bytes")?;
        let prompt_expires_at_ms = checked_i64(prompt.expires_at_ms, "Prompt expiry timestamp")?;
        self.0
            .execute(
                "INSERT INTO request_attempts (
                attempt_id, request_id, originator_kind, originator_identity_id,
                recipient_identity_id, nonce, identity_id, server_id, socket_path,
                server_pid, server_start_time, pane_id, pane_pid, wait_active, status,
                preamble_every, inject_preamble, cadence_reserved, prepared_at_ms,
                sending_at_ms, settled_at_ms, wait_released_at_ms,
                response_submitted_at_ms, expires_at_ms, retention_days,
                retention_expires_at_ms, attention_revision,
                attention_acknowledged_revision, message_text, message_bytes,
                message_expires_at_ms
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?
            )",
                params![
                    attempt.attempt_id,
                    attempt.request_id,
                    attempt.originator.as_str(),
                    attempt.originator.identity_id(),
                    attempt.recipient_identity_id,
                    attempt.nonce,
                    attempt.identity_id,
                    attempt.endpoint.server.server_id,
                    attempt.endpoint.server.socket_path,
                    server_pid,
                    attempt.endpoint.server.server_start_time,
                    attempt.endpoint.pane_id,
                    pane_pid,
                    if attempt.wait_active { 1 } else { 0 },
                    attempt.status.as_str(),
                    preamble_every,
                    if attempt.inject_preamble { 1 } else { 0 },
                    if attempt.cadence_reserved { 1 } else { 0 },
                    prepared_at_ms,
                    sending_at_ms,
                    settled_at_ms,
                    wait_released_at_ms,
                    response_submitted_at_ms,
                    expires_at_ms,
                    retention_days,
                    retention_expires_at_ms,
                    revision,
                    0_i64,
                    prompt.message,
                    prompt_bytes,
                    prompt_expires_at_ms,
                ],
            )
            .map_err(|error| classify(error, "Create request attempt"))?;
        Ok(())
    }

    fn create_response(&mut self, response: &FinalResponse) -> Result<(), Self::Error> {
        let server_pid = checked_i64(response.endpoint.server.server_pid, "Server PID")?;
        let pane_pid = checked_i64(response.endpoint.pane_pid, "Pane PID")?;
        let body_bytes = checked_i64(response.body_bytes, "Response bytes")?;
        let submitted_at_ms = checked_i64(response.submitted_at_ms, "Submission timestamp")?;
        let response_expires_at_ms =
            checked_i64(response.response_expires_at_ms, "Response expiry timestamp")?;
        self.0
            .execute(
                "INSERT INTO request_responses (
                request_id, attempt_id, server_id, socket_path, server_pid,
                server_start_time, pane_id, pane_pid, body, body_bytes,
                submitted_at_ms, response_expires_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    response.request_id,
                    response.attempt_id,
                    response.endpoint.server.server_id,
                    response.endpoint.server.socket_path,
                    server_pid,
                    response.endpoint.server.server_start_time,
                    response.endpoint.pane_id,
                    pane_pid,
                    response.body,
                    body_bytes,
                    submitted_at_ms,
                    response_expires_at_ms,
                ],
            )
            .map_err(|error| classify(error, "Create request response"))?;
        let changed = self
            .0
            .execute(
                "UPDATE request_attempts
             SET response_submitted_at_ms = ?,
                 retention_expires_at_ms = MAX(retention_expires_at_ms, ?)
             WHERE attempt_id = ? AND request_id = ?
               AND response_submitted_at_ms IS NULL",
                params![
                    submitted_at_ms,
                    response_expires_at_ms,
                    response.attempt_id,
                    response.request_id,
                ],
            )
            .map_err(|error| classify(error, "Record request response completion"))?;
        if changed != 1 {
            return Err(StorageError::new(
                StorageErrorCode::Unknown,
                format!(
                    "Request attempt '{}' could not record response completion",
                    response.attempt_id
                ),
            ));
        }
        Ok(())
    }

    fn update_state(
        &mut self,
        attempt: &RequestAttempt,
        status: AttemptStatus,
        reserved: bool,
        now_ms: u64,
        horizon: Option<u64>,
    ) -> Result<bool, Self::Error> {
        let now = checked_i64(now_ms, "Request state timestamp")?;
        let horizon = horizon
            .map(|value| checked_i64(value, "Request retention horizon"))
            .transpose()?;
        let changed = self
            .0
            .execute(
                "UPDATE request_attempts
             SET status = ?,
                 cadence_reserved = ?,
                 sending_at_ms = CASE
                     WHEN ? = 'sending' THEN ? ELSE sending_at_ms
                 END,
                 settled_at_ms = CASE
                     WHEN ? IN ('sent', 'uncertain', 'definitely_failed')
                         THEN ? ELSE settled_at_ms
                 END,
                 retention_expires_at_ms = MAX(
                     retention_expires_at_ms,
                     COALESCE(?, retention_expires_at_ms)
                 )
             WHERE attempt_id = ? AND status = ?",
                params![
                    status.as_str(),
                    if reserved { 1 } else { 0 },
                    status.as_str(),
                    now,
                    status.as_str(),
                    now,
                    horizon,
                    attempt.attempt_id,
                    attempt.status.as_str(),
                ],
            )
            .map_err(|error| classify(error, "Update request state"))?;
        Ok(changed == 1)
    }

    fn release_wait(&mut self, attempt_id: &str, now_ms: u64) -> Result<bool, Self::Error> {
        let changed = self
            .0
            .execute(
                "UPDATE request_attempts SET wait_active = 0, wait_released_at_ms = ?
             WHERE attempt_id = ? AND wait_active = 1",
                params![checked_i64(now_ms, "Wait release timestamp")?, attempt_id],
            )
            .map_err(|error| classify(error, "Release request wait"))?;
        Ok(changed == 1)
    }

    fn preamble_count(&self, identity_id: &str) -> Result<u64, Self::Error> {
        self.0
            .query_row(
                "SELECT reserved_count FROM preamble_counters WHERE identity_id = ?",
                [identity_id],
                |row| rows::u64_at(row, 0),
            )
            .optional()
            .map_err(|error| classify(error, "Read preamble counter"))
            .map(|value| value.unwrap_or(0))
    }

    fn set_preamble_count(
        &mut self,
        identity_id: &str,
        count: u64,
        now_ms: u64,
    ) -> Result<(), Self::Error> {
        self.0
            .execute(
                "INSERT INTO preamble_counters (identity_id, reserved_count, updated_at_ms)
             VALUES (?, ?, ?) ON CONFLICT(identity_id) DO UPDATE SET
               reserved_count = excluded.reserved_count,
               updated_at_ms = excluded.updated_at_ms",
                params![
                    identity_id,
                    checked_i64(count, "Preamble counter")?,
                    checked_i64(now_ms, "Preamble counter timestamp")?
                ],
            )
            .map_err(|error| classify(error, "Set preamble counter"))?;
        Ok(())
    }

    fn attention_counter(&self, identity_id: &str) -> Result<Option<u64>, Self::Error> {
        self.0
            .query_row(
                "SELECT latest_revision FROM request_attention_identities WHERE identity_id = ?",
                [identity_id],
                |row| rows::u64_at(row, 0),
            )
            .optional()
            .map_err(|error| classify(error, "Read attention counter"))
    }

    fn set_attention_counter(
        &mut self,
        identity_id: &str,
        expected: Option<u64>,
        next: u64,
    ) -> Result<(), Self::Error> {
        let next = checked_i64(next, "Attention revision")?;
        let changed = match expected {
            None => self
                .0
                .execute(
                    "INSERT INTO request_attention_identities
                 (identity_id, latest_revision, acknowledged_through) VALUES (?, ?, 0)",
                    params![identity_id, next],
                )
                .map_err(|error| classify(error, "Create attention counter"))?,
            Some(expected) => self
                .0
                .execute(
                    "UPDATE request_attention_identities SET latest_revision = ?
                 WHERE identity_id = ? AND latest_revision = ?",
                    params![
                        next,
                        identity_id,
                        checked_i64(expected, "Expected attention revision")?
                    ],
                )
                .map_err(|error| classify(error, "Advance attention counter"))?,
        };
        if expected.is_some() && changed != 1 {
            return Err(StorageError::new(
                StorageErrorCode::Unknown,
                format!("Attention counter for identity '{identity_id}' changed unexpectedly"),
            ));
        }
        Ok(())
    }

    fn set_attention_revision(
        &mut self,
        request_id: &str,
        revision: u64,
    ) -> Result<(), Self::Error> {
        let changed = self
            .0
            .execute(
                "UPDATE request_attempts SET attention_revision = ? WHERE request_id = ?",
                params![checked_i64(revision, "Attention revision")?, request_id],
            )
            .map_err(|error| classify(error, "Set request attention revision"))?;
        if changed != 1 {
            return Err(StorageError::new(
                StorageErrorCode::Unknown,
                format!("Request '{request_id}' was not found"),
            ));
        }
        Ok(())
    }

    fn expired_attempts(
        &self,
        now_ms: u64,
        limit: u64,
    ) -> Result<Vec<RequestAttempt>, Self::Error> {
        let query = format!(
            "SELECT {} FROM request_attempts
             WHERE expires_at_ms <= ? AND (wait_active = 1 OR status IN ('prepared', 'sending'))
             ORDER BY expires_at_ms, attempt_id LIMIT ?",
            rows::ATTEMPT_COLUMNS
        );
        let mut statement = self
            .0
            .prepare(&query)
            .map_err(|error| classify(error, "Prepare expired request query"))?;
        let rows = statement
            .query_map(
                params![
                    checked_now(now_ms, "Request expiry cutoff")?,
                    checked_limit(limit)?
                ],
                rows::attempt_row,
            )
            .map_err(|error| classify(error, "List expired requests"))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| classify(error, "Decode expired requests"))
    }

    fn clear_expired_prompts(&mut self, now_ms: u64, limit: u64) -> Result<(), Self::Error> {
        self.0
            .execute(
                "UPDATE request_attempts
             SET message_text = NULL, message_bytes = NULL
             WHERE attempt_id IN (
                 SELECT attempt_id FROM request_attempts
                 WHERE message_text IS NOT NULL
                   AND message_expires_at_ms <= ?
                 ORDER BY message_expires_at_ms, attempt_id
                 LIMIT ?
             )",
                params![
                    checked_now(now_ms, "Prompt retention cutoff")?,
                    checked_limit(limit)?
                ],
            )
            .map_err(|error| classify(error, "Clear expired request prompts"))?;
        Ok(())
    }

    fn delete_expired_responses(&mut self, now_ms: u64, limit: u64) -> Result<(), Self::Error> {
        self.0
            .execute(
                "DELETE FROM request_responses
             WHERE request_id IN (
                 SELECT request_id FROM request_responses
                 WHERE response_expires_at_ms <= ?
                 ORDER BY response_expires_at_ms, request_id
                 LIMIT ?
             )",
                params![
                    checked_now(now_ms, "Response retention cutoff")?,
                    checked_limit(limit)?
                ],
            )
            .map_err(|error| classify(error, "Delete expired request responses"))?;
        Ok(())
    }

    fn delete_retained(
        &mut self,
        now_ms: u64,
        settled_cutoff_ms: u64,
        limit: u64,
    ) -> Result<(), Self::Error> {
        let now = checked_now(now_ms, "Request retention cutoff")?;
        let settled_cutoff = checked_i64(settled_cutoff_ms, "Settlement retention cutoff")?;
        self.0
            .execute(
                DELETE_RETAINED_SQL,
                params![settled_cutoff, now, now, checked_limit(limit)?],
            )
            .map_err(|error| classify(error, "Delete retained requests"))?;
        Ok(())
    }
}

impl RequestRepository for Storage {
    type Error = StorageError;

    fn with_request_transaction<T, E: From<Self::Error>>(
        &mut self,
        operation: impl FnOnce(&mut dyn RequestRecords<Error = Self::Error>) -> Result<T, E>,
    ) -> Result<T, E> {
        with_immediate_transaction(self, "request", |transaction| {
            operation(&mut RequestRows(transaction))
        })
    }
}

#[cfg(test)]
mod service_tests;
#[cfg(test)]
mod tests;
