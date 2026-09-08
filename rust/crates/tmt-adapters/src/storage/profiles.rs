//! Profile SQL composes over the existing identity records and connection.

#[cfg(test)]
mod tests;

use super::{
    Storage, StorageError,
    errors::classify,
    identities::{IdentityRecords, identity_row_at, with_immediate_transaction},
};
use rusqlite::{OptionalExtension, Row, params};
use tmt_core::identity::Identity;
use tmt_core::profile::{Profile, ProfileKind, ProfileReader, ProfileRepository, ProfileWriter};

fn table(kind: ProfileKind) -> &'static str {
    match kind {
        ProfileKind::Role => "role_profiles",
        ProfileKind::Preamble => "identity_preambles",
    }
}

fn profile_row_at(row: &Row<'_>, offset: usize) -> rusqlite::Result<Profile> {
    Ok(Profile {
        content: row.get(offset)?,
        updated_at: row.get(offset + 1)?,
    })
}

impl ProfileReader for Storage {
    fn find_profile(
        &self,
        identity_id: &str,
        kind: ProfileKind,
    ) -> Result<Option<Profile>, StorageError> {
        self.connection()?.query_row(
            &format!("SELECT p.content, p.updated_at FROM {} p JOIN identities i ON i.id = p.identity_id WHERE i.id = ? AND i.retired_at_ms IS NULL", table(kind)),
            [identity_id], |row| profile_row_at(row, 0)
        ).optional().map_err(|error| classify(error, "Read profile"))
    }

    fn list_preambles(&self) -> Result<Vec<(Identity, Profile)>, StorageError> {
        let mut query = self.connection()?.prepare("SELECT i.id, i.name, i.canonical_name, i.lifetime, i.created_at, i.updated_at, p.content, p.updated_at FROM identities i JOIN identity_preambles p ON p.identity_id = i.id WHERE i.retired_at_ms IS NULL ORDER BY i.canonical_name COLLATE BINARY")
            .map_err(|error| classify(error, "Prepare preamble list"))?;
        query
            .query_map([], |row| {
                Ok((identity_row_at(row, 0)?, profile_row_at(row, 6)?))
            })
            .and_then(|rows| rows.collect())
            .map_err(|error| classify(error, "List preambles"))
    }
}

impl ProfileWriter for IdentityRecords<'_> {
    fn set_profile(
        &mut self,
        identity_id: &str,
        kind: ProfileKind,
        content: &str,
    ) -> Result<Profile, StorageError> {
        self.0.query_row(&format!("INSERT INTO {} (identity_id, content, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ON CONFLICT(identity_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at RETURNING content, updated_at", table(kind)),
            params![identity_id, content], |row| profile_row_at(row, 0)).map_err(|error| classify(error, "Set profile"))
    }
    fn clear_profile(
        &mut self,
        identity_id: &str,
        kind: ProfileKind,
    ) -> Result<bool, StorageError> {
        self.0
            .execute(
                &format!("DELETE FROM {} WHERE identity_id = ?", table(kind)),
                [identity_id],
            )
            .map(|count| count > 0)
            .map_err(|error| classify(error, "Clear profile"))
    }
}

impl ProfileRepository for Storage {
    fn with_profile_transaction<T>(
        &mut self,
        operation: impl FnOnce(&mut dyn ProfileWriter<Error = StorageError>) -> Result<T, StorageError>,
    ) -> Result<T, StorageError> {
        with_immediate_transaction(self, "profile", |transaction| {
            operation(&mut IdentityRecords(transaction))
        })
    }
}
