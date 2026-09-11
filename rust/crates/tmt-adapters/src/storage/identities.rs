//! Identity SQL shares the invocation-owned connection and schema history.

use rusqlite::{Connection, OptionalExtension, Row, Transaction, TransactionBehavior, params};
use tmt_core::{
    identity::{Identity, IdentityReader, IdentityRepository, IdentityWriter, Lifetime},
    names::ValidatedName,
};

use super::{Storage, StorageError, StorageErrorCode, errors::classify};

const COLUMNS: &str = "id, name, canonical_name, lifetime, created_at, updated_at";

pub(super) struct IdentityRecords<'a>(pub(super) &'a Connection);

pub(super) fn identity_row_at(row: &Row<'_>, offset: usize) -> rusqlite::Result<Identity> {
    let lifetime = match row.get::<_, String>(offset + 3)?.as_str() {
        "temporary" => Lifetime::Temporary,
        "saved" => Lifetime::Saved,
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    Ok(Identity {
        id: row.get(offset)?,
        name: row.get(offset + 1)?,
        canonical_name: row.get(offset + 2)?,
        lifetime,
        created_at: row.get(offset + 4)?,
        updated_at: row.get(offset + 5)?,
    })
}

fn identity_row(row: &Row<'_>) -> rusqlite::Result<Identity> {
    identity_row_at(row, 0)
}

impl IdentityReader for IdentityRecords<'_> {
    type Error = StorageError;

    fn find_identity(&self, canonical_name: &str) -> Result<Option<Identity>, Self::Error> {
        self.0
            .query_row(
                &format!("SELECT {COLUMNS} FROM identities WHERE canonical_name = ? AND retired_at_ms IS NULL"),
                [canonical_name],
                identity_row,
            )
            .optional()
            .map_err(|error| classify(error, "Find identity"))
    }

    fn list_identities(&self) -> Result<Vec<Identity>, Self::Error> {
        let mut statement = self.0.prepare(&format!(
            "SELECT {COLUMNS} FROM identities WHERE retired_at_ms IS NULL ORDER BY canonical_name COLLATE BINARY"
        )).map_err(|error| classify(error, "Prepare identity list"))?;
        statement
            .query_map([], identity_row)
            .and_then(|rows| rows.collect())
            .map_err(|error| classify(error, "List identities"))
    }
}

impl IdentityWriter for IdentityRecords<'_> {
    fn insert_identity(
        &mut self,
        name: &ValidatedName,
        lifetime: Lifetime,
    ) -> Result<Identity, Self::Error> {
        self.0.query_row(
            &format!("INSERT INTO identities (id, name, canonical_name, lifetime, created_at, updated_at) \
                VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) RETURNING {COLUMNS}"),
            params![uuid::Uuid::new_v4().to_string(), name.display_name(), name.canonical_name(), lifetime.as_str()],
            identity_row,
        ).map_err(|error| classify(error, "Create identity"))
    }

    fn save_identity(&mut self, identity: &Identity) -> Result<Identity, Self::Error> {
        self.0.query_row(
            &format!("UPDATE identities SET lifetime = 'saved', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') \
                WHERE id = ? AND retired_at_ms IS NULL AND lifetime = 'temporary' RETURNING {COLUMNS}"),
            [&identity.id], identity_row,
        ).map_err(|error| classify(error, "Save identity"))
    }
}

impl IdentityReader for Storage {
    type Error = StorageError;

    fn find_identity(&self, canonical_name: &str) -> Result<Option<Identity>, Self::Error> {
        IdentityRecords(self.connection()?).find_identity(canonical_name)
    }

    fn list_identities(&self) -> Result<Vec<Identity>, Self::Error> {
        IdentityRecords(self.connection()?).list_identities()
    }
}

impl Storage {
    /// Office revalidates the originally selected UUID across separate calls;
    /// a same-name replacement must never inherit a pending proof or credential.
    pub fn find_active_identity_by_id(&self, id: &str) -> Result<Option<Identity>, StorageError> {
        self.connection()?
            .query_row(
                &format!("SELECT {COLUMNS} FROM identities WHERE id = ? AND retired_at_ms IS NULL"),
                [id],
                identity_row,
            )
            .optional()
            .map_err(|error| classify(error, "Find active identity by ID"))
    }
}

impl IdentityRepository for Storage {
    fn with_identity_transaction<T>(
        &mut self,
        operation: impl FnOnce(&mut dyn IdentityWriter<Error = Self::Error>) -> Result<T, Self::Error>,
    ) -> Result<T, Self::Error> {
        with_immediate_transaction(self, "identity", |transaction| {
            operation(&mut IdentityRecords(transaction))
        })
    }
}

pub(super) fn with_immediate_transaction<T, E>(
    storage: &mut Storage,
    operation_name: &str,
    operation: impl FnOnce(&Transaction<'_>) -> Result<T, E>,
) -> Result<T, E>
where
    E: From<StorageError>,
{
    let connection = storage.connection.as_mut().ok_or_else(|| {
        E::from(StorageError::new(
            StorageErrorCode::Closed,
            "Storage is already closed",
        ))
    })?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| {
            E::from(classify(
                error,
                &format!("Begin {operation_name} transaction"),
            ))
        })?;
    let result = operation(&transaction)?;
    transaction.commit().map_err(|error| {
        E::from(classify(
            error,
            &format!("Commit {operation_name} transaction"),
        ))
    })?;
    Ok(result)
}

#[cfg(test)]
mod tests;
