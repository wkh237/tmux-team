//! One atomic self-report per identity; reads neither renew nor delete expired state.

use super::{
    Storage, StorageError, StorageErrorCode, errors::classify,
    identities::with_immediate_transaction,
};
use rusqlite::{OptionalExtension, params};
use std::collections::HashMap;
use tmt_core::identity_status::{
    IdentityStatus, IdentityStatusRepository, StatusClear, StatusLookup,
};

impl IdentityStatusRepository for Storage {
    type Error = StorageError;

    fn read_identity_status(&self, identity_id: &str) -> Result<StatusLookup, Self::Error> {
        let row = self.connection()?.query_row(
            "SELECT s.activity, s.mood, s.updated_at_ms, s.expires_at_ms FROM identities i
             LEFT JOIN identity_status s ON s.identity_id = i.id WHERE i.id = ? AND i.retired_at_ms IS NULL",
            [identity_id], |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, Option<i64>>(2)?, row.get::<_, Option<i64>>(3)?)),
        ).optional().map_err(|error| classify(error, "Read identity status"))?;
        match row {
            None => Ok(StatusLookup::IdentityInactive),
            Some((None, None, None, None)) => Ok(StatusLookup::Found(None)),
            Some((Some(activity), mood, Some(updated_at_ms), Some(expires_at_ms))) => {
                Ok(StatusLookup::Found(Some(decode_status(
                    activity,
                    mood,
                    updated_at_ms,
                    expires_at_ms,
                )?)))
            }
            Some(_) => Err(StorageError::new(
                StorageErrorCode::Unknown,
                "Stored identity status is incomplete",
            )),
        }
    }

    fn write_identity_status(
        &mut self,
        identity_id: &str,
        status: &IdentityStatus,
    ) -> Result<bool, Self::Error> {
        validate(status)?;
        with_immediate_transaction(self, "identity status", |transaction| {
            let changed = transaction.execute(
                "INSERT INTO identity_status (identity_id, activity, mood, updated_at_ms, expires_at_ms)
                 SELECT id, ?2, ?3, ?4, ?5 FROM identities WHERE id = ?1 AND retired_at_ms IS NULL
                 ON CONFLICT(identity_id) DO UPDATE SET activity = excluded.activity, mood = excluded.mood,
                 updated_at_ms = excluded.updated_at_ms, expires_at_ms = excluded.expires_at_ms",
                params![identity_id, status.activity, status.mood, status.updated_at_ms as i64, status.expires_at_ms as i64],
            ).map_err(|error| classify(error, "Write identity status"))?;
            Ok(changed == 1)
        })
    }

    fn clear_identity_status(&mut self, identity_id: &str) -> Result<StatusClear, Self::Error> {
        with_immediate_transaction(self, "identity status", |transaction| {
            let active: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM identities WHERE id = ? AND retired_at_ms IS NULL)",
                [identity_id], |row| row.get(0),
            ).map_err(|error| classify(error, "Find identity for status clear"))?;
            if !active {
                return Ok(StatusClear::IdentityInactive);
            }
            let removed = transaction
                .execute(
                    "DELETE FROM identity_status WHERE identity_id = ?",
                    [identity_id],
                )
                .map_err(|error| classify(error, "Clear identity status"))?
                == 1;
            Ok(StatusClear::Cleared { removed })
        })
    }
}

impl Storage {
    /// One directory read, independent of appearance revisions and room membership.
    /// Keep expired records for details; retirement alone excludes an identity.
    pub fn list_active_identity_statuses(
        &self,
    ) -> Result<HashMap<String, IdentityStatus>, StorageError> {
        let mut query = self
            .connection()?
            .prepare(
                "SELECT s.identity_id, s.activity, s.mood, s.updated_at_ms, s.expires_at_ms
             FROM identity_status s JOIN identities i ON i.id = s.identity_id
             WHERE i.retired_at_ms IS NULL",
            )
            .map_err(|error| classify(error, "Prepare identity status directory"))?;
        let rows = query
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })
            .map_err(|error| classify(error, "Read identity status directory"))?;
        rows.map(|row| {
            let (id, activity, mood, updated, expires) =
                row.map_err(|error| classify(error, "Read identity status row"))?;
            Ok((id, decode_status(activity, mood, updated, expires)?))
        })
        .collect()
    }
}

fn decode_status(
    activity: String,
    mood: Option<String>,
    updated_at_ms: i64,
    expires_at_ms: i64,
) -> Result<IdentityStatus, StorageError> {
    let status = IdentityStatus {
        activity,
        mood,
        updated_at_ms: stored_time(updated_at_ms)?,
        expires_at_ms: stored_time(expires_at_ms)?,
    };
    validate(&status)?;
    Ok(status)
}

fn validate(status: &IdentityStatus) -> Result<(), StorageError> {
    status.validate().map_err(|error| {
        StorageError::new(StorageErrorCode::Unknown, "Invalid identity status").caused_by(error)
    })
}

fn stored_time(value: i64) -> Result<u64, StorageError> {
    value.try_into().map_err(|error| {
        StorageError::new(StorageErrorCode::Unknown, "Invalid stored status timestamp")
            .caused_by(error)
    })
}

#[cfg(test)]
mod tests;
