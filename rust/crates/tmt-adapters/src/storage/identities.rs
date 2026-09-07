//! Identity SQL shares the invocation-owned connection and schema history.

use rusqlite::{Connection, OptionalExtension, Row, TransactionBehavior, params};
use tmt_core::{
    identity::{Identity, IdentityReader, IdentityRepository, IdentityWriter, Lifetime},
    names::ValidatedName,
};

use super::{Storage, StorageError, StorageErrorCode, errors::classify};

const COLUMNS: &str = "id, name, canonical_name, lifetime, created_at, updated_at";

struct IdentityRecords<'a>(&'a Connection);

fn identity_row(row: &Row<'_>) -> rusqlite::Result<Identity> {
    let lifetime = match row.get::<_, String>(3)?.as_str() {
        "temporary" => Lifetime::Temporary,
        "saved" => Lifetime::Saved,
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    Ok(Identity {
        id: row.get(0)?,
        name: row.get(1)?,
        canonical_name: row.get(2)?,
        lifetime,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
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

impl IdentityRepository for Storage {
    fn with_identity_transaction<T>(
        &mut self,
        operation: impl FnOnce(&mut dyn IdentityWriter<Error = Self::Error>) -> Result<T, Self::Error>,
    ) -> Result<T, Self::Error> {
        let connection = self.connection.as_mut().ok_or_else(|| {
            StorageError::new(StorageErrorCode::Closed, "Storage is already closed")
        })?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| classify(error, "Begin identity transaction"))?;
        let result = operation(&mut IdentityRecords(&transaction))?;
        transaction
            .commit()
            .map_err(|error| classify(error, "Commit identity transaction"))?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests;
