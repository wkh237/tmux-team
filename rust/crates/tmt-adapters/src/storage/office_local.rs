//! Installation-owned Office data stored beside the existing identity repository.

use rusqlite::{OptionalExtension, params};
use std::collections::HashMap;
use tmt_core::office_block::{BlockLayout, LocalBlockLayout, MAX_REVISION, PropPlacement};

use crate::office_prop::{BUILTIN_DIGEST, builtin_pack, parse_prop_reference, validate_pack};

use super::{
    Storage, StorageError, StorageErrorCode, errors::classify,
    identities::with_immediate_transaction,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalBlockSnapshot {
    pub identity_id: String,
    pub identity_name: String,
    pub block_id: Option<String>,
    pub revision: u64,
    pub layout: LocalBlockLayout,
    pub updated_at_ms: u64,
    pub changed: bool,
    pub resolutions: Vec<LocalPropResolution>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalPropResolution {
    Available { label: String },
    Unavailable { digest_prefix: String },
}

impl LocalBlockSnapshot {
    pub fn exists(&self) -> bool {
        self.block_id.is_some()
    }
}

#[derive(Debug)]
pub enum LocalOfficeError {
    Storage(StorageError),
    IdentityInactive,
    RevisionConflict,
    RevisionExhausted,
    StoredLayoutInvalid,
    LayoutInvalid,
    PropNotFound,
    PropCorrupt,
}

impl std::fmt::Display for LocalOfficeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Storage(_) => "Could not access local Office storage.",
            Self::IdentityInactive => "The selected identity is not active.",
            Self::RevisionConflict => "The local Office block changed.",
            Self::RevisionExhausted => "The local Office block revision is exhausted.",
            Self::StoredLayoutInvalid => "The stored local Office layout is invalid.",
            Self::LayoutInvalid => "The proposed local Office layout is invalid.",
            Self::PropNotFound => "The referenced local Office prop is unavailable.",
            Self::PropCorrupt => "The referenced local Office prop pack is corrupt.",
        })
    }
}

impl std::error::Error for LocalOfficeError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Storage(error) => Some(error),
            _ => None,
        }
    }
}

impl From<StorageError> for LocalOfficeError {
    fn from(error: StorageError) -> Self {
        Self::Storage(error)
    }
}

impl Storage {
    pub fn show_local_block(
        &mut self,
        identity_id: &str,
    ) -> Result<LocalBlockSnapshot, LocalOfficeError> {
        let transaction = self
            .connection_mut()?
            .transaction_with_behavior(rusqlite::TransactionBehavior::Deferred)
            .map_err(|error| classify(error, "Observe local Office block"))?;
        let identity_name = transaction
            .query_row(
                "SELECT name FROM identities WHERE id = ? AND retired_at_ms IS NULL",
                [identity_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| classify(error, "Read local Office identity"))?
            .ok_or(LocalOfficeError::IdentityInactive)?;
        let stored = transaction
            .query_row(
                "SELECT block_id, revision, layout, updated_at_ms FROM office_local_blocks WHERE identity_id = ?",
                [identity_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| classify(error, "Read local Office block"))?;
        let snapshot = snapshot(&transaction, identity_id, identity_name, stored)?;
        transaction
            .commit()
            .map_err(|error| classify(error, "Finish local Office block observation"))?;
        Ok(snapshot)
    }

    pub fn list_active_local_blocks(
        &mut self,
    ) -> Result<Vec<LocalBlockSnapshot>, LocalOfficeError> {
        let transaction = self
            .connection_mut()?
            .transaction_with_behavior(rusqlite::TransactionBehavior::Deferred)
            .map_err(|error| classify(error, "Observe active local Office blocks"))?;
        let mut statement = transaction
            .prepare(
                "SELECT b.identity_id, i.name, b.block_id, b.revision, b.layout, b.updated_at_ms \
                 FROM office_local_blocks b JOIN identities i ON i.id = b.identity_id \
                 WHERE i.retired_at_ms IS NULL ORDER BY i.canonical_name COLLATE BINARY, b.block_id",
            )
            .map_err(|error| classify(error, "Prepare active local Office blocks"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            })
            .map_err(|error| classify(error, "List active local Office blocks"))?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| classify(error, "Read active local Office block"))?;
        drop(statement);
        let snapshots = rows
            .into_iter()
            .map(
                |(identity_id, identity_name, block_id, revision, layout, updated_at_ms)| {
                    let layout = decode_layout(&layout)?;
                    let resolutions = resolve_layout(&transaction, &layout)?;
                    Ok(LocalBlockSnapshot {
                        identity_id,
                        identity_name,
                        block_id: Some(block_id),
                        revision: stored_u64(revision)?,
                        layout,
                        updated_at_ms: stored_u64(updated_at_ms)?,
                        changed: false,
                        resolutions,
                    })
                },
            )
            .collect::<Result<Vec<_>, LocalOfficeError>>()?;
        transaction
            .commit()
            .map_err(|error| classify(error, "Finish active local Office block observation"))?;
        Ok(snapshots)
    }

    pub fn show_active_local_block_by_block_id(
        &mut self,
        block_id: &str,
    ) -> Result<LocalBlockSnapshot, LocalOfficeError> {
        let transaction = self
            .connection_mut()?
            .transaction_with_behavior(rusqlite::TransactionBehavior::Deferred)
            .map_err(|error| classify(error, "Observe active local Office block"))?;
        let stored = transaction
            .query_row(
                "SELECT b.identity_id, i.name, b.block_id, b.revision, b.layout, b.updated_at_ms \
                 FROM office_local_blocks b JOIN identities i ON i.id = b.identity_id \
                 WHERE b.block_id = ? AND i.retired_at_ms IS NULL",
                [block_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, i64>(5)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| classify(error, "Read active local Office block"))?
            .ok_or(LocalOfficeError::IdentityInactive)?;
        let (identity_id, identity_name, block_id, revision, layout, updated_at_ms) = stored;
        let layout = decode_layout(&layout)?;
        let resolutions = resolve_layout(&transaction, &layout)?;
        let snapshot = LocalBlockSnapshot {
            identity_id,
            identity_name,
            block_id: Some(block_id),
            revision: stored_u64(revision)?,
            layout,
            updated_at_ms: stored_u64(updated_at_ms)?,
            changed: false,
            resolutions,
        };
        transaction
            .commit()
            .map_err(|error| classify(error, "Finish active local Office block observation"))?;
        Ok(snapshot)
    }

    pub fn apply_active_local_block_by_block_id(
        &mut self,
        block_id: &str,
        expected_revision: u64,
        layout: &LocalBlockLayout,
    ) -> Result<LocalBlockSnapshot, LocalOfficeError> {
        let identity_id = self
            .connection()?
            .query_row(
                "SELECT b.identity_id FROM office_local_blocks b JOIN identities i ON i.id = b.identity_id \
                 WHERE b.block_id = ? AND i.retired_at_ms IS NULL",
                [block_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| classify(error, "Resolve active local Office block"))?
            .ok_or(LocalOfficeError::IdentityInactive)?;
        self.apply_local_block(&identity_id, expected_revision, layout)
    }

    pub fn apply_local_block(
        &mut self,
        identity_id: &str,
        expected_revision: u64,
        layout: &LocalBlockLayout,
    ) -> Result<LocalBlockSnapshot, LocalOfficeError> {
        with_immediate_transaction(self, "local Office block", |transaction| {
            let identity_name = transaction
                .query_row(
                    "SELECT name FROM identities WHERE id = ? AND retired_at_ms IS NULL",
                    [identity_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| classify(error, "Revalidate local Office identity"))?
                .ok_or(LocalOfficeError::IdentityInactive)?;
            let current = transaction
                .query_row(
                    "SELECT block_id, revision, layout, updated_at_ms FROM office_local_blocks WHERE identity_id = ?",
                    [identity_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, i64>(3)?,
                        ))
                    },
                )
                .optional()
                .map_err(|error| classify(error, "Read local Office revision"))?;
            let encoded = serde_json::to_string(&crate::office_block::local_layout_value(layout))
                .map_err(|error| {
                StorageError::new(
                    StorageErrorCode::Unknown,
                    "Encode local Office layout failed",
                )
                .caused_by(error)
            })?;
            let now = current_time_ms()?;
            let (block_id, revision, updated_at_ms, changed) = match current {
                None if expected_revision == 0 => {
                    validate_mutation(transaction, None, layout)?;
                    transaction
                        .execute(
                            "INSERT OR IGNORE INTO office_local_worlds (singleton, id, created_at_ms) VALUES (1, ?, ?)",
                            params![
                                uuid::Uuid::new_v4().to_string(),
                                i64::try_from(now).expect("current timestamp fits SQLite")
                            ],
                        )
                        .map_err(|error| classify(error, "Create local Office world"))?;
                    let block_id = uuid::Uuid::new_v4().to_string();
                    transaction
                        .execute(
                            "INSERT INTO office_local_blocks (block_id, identity_id, revision, layout, updated_at_ms) VALUES (?, ?, 1, ?, ?)",
                            params![
                                block_id,
                                identity_id,
                                encoded,
                                i64::try_from(now).expect("current timestamp fits SQLite")
                            ],
                        )
                        .map_err(|error| classify(error, "Create local Office block"))?;
                    (block_id, 1, now, true)
                }
                None => return Err(LocalOfficeError::RevisionConflict),
                Some((block_id, revision, stored_layout, updated_at_ms))
                    if expected_revision.checked_add(1) == Some(stored_u64(revision)?)
                        && decode_layout(&stored_layout)? == *layout =>
                {
                    let resolutions = resolve_layout(transaction, layout)?;
                    return Ok(LocalBlockSnapshot {
                        identity_id: identity_id.to_owned(),
                        identity_name,
                        block_id: Some(block_id),
                        revision: stored_u64(revision)?,
                        layout: layout.clone(),
                        updated_at_ms: stored_u64(updated_at_ms)?,
                        changed: false,
                        resolutions,
                    });
                }
                Some((_, revision, _, _)) if stored_u64(revision)? != expected_revision => {
                    return Err(LocalOfficeError::RevisionConflict);
                }
                Some((block_id, revision, stored_layout, updated_at_ms))
                    if decode_layout(&stored_layout)? == *layout =>
                {
                    let resolutions = resolve_layout(transaction, layout)?;
                    return Ok(LocalBlockSnapshot {
                        identity_id: identity_id.to_owned(),
                        identity_name,
                        block_id: Some(block_id),
                        revision: stored_u64(revision)?,
                        layout: layout.clone(),
                        updated_at_ms: stored_u64(updated_at_ms)?,
                        changed: false,
                        resolutions,
                    });
                }
                Some((_, revision, _, _)) if stored_u64(revision)? >= MAX_REVISION => {
                    return Err(LocalOfficeError::RevisionExhausted);
                }
                Some((block_id, stored_revision, stored_layout, _)) => {
                    let current_layout = decode_layout(&stored_layout)?;
                    validate_mutation(transaction, Some(&current_layout), layout)?;
                    let revision = stored_u64(stored_revision)?;
                    let next = revision + 1;
                    let changed = transaction
                        .execute(
                            "UPDATE office_local_blocks SET revision = ?, layout = ?, updated_at_ms = ? \
                             WHERE block_id = ? AND identity_id = ? AND revision = ? \
                             AND EXISTS (SELECT 1 FROM identities WHERE id = ? AND retired_at_ms IS NULL)",
                            params![
                                i64::try_from(next).expect("safe Office revision fits SQLite"),
                                encoded,
                                i64::try_from(now).expect("current timestamp fits SQLite"),
                                block_id,
                                identity_id,
                                stored_revision,
                                identity_id
                            ],
                        )
                        .map_err(|error| classify(error, "Update local Office block"))?;
                    if changed != 1 {
                        return Err(LocalOfficeError::IdentityInactive);
                    }
                    (block_id, next, now, true)
                }
            };
            let resolutions = resolve_layout(transaction, layout)?;
            Ok(LocalBlockSnapshot {
                identity_id: identity_id.to_owned(),
                identity_name,
                block_id: Some(block_id),
                revision,
                layout: layout.clone(),
                updated_at_ms,
                changed,
                resolutions,
            })
        })
    }
}

fn snapshot(
    connection: &rusqlite::Connection,
    identity_id: &str,
    identity_name: String,
    stored: Option<(String, i64, String, i64)>,
) -> Result<LocalBlockSnapshot, LocalOfficeError> {
    let Some((block_id, revision, layout, updated_at_ms)) = stored else {
        return Ok(LocalBlockSnapshot {
            identity_id: identity_id.to_owned(),
            identity_name,
            block_id: None,
            revision: 0,
            layout: LocalBlockLayout::new(Vec::new()).expect("empty block layout is valid"),
            updated_at_ms: 0,
            changed: false,
            resolutions: Vec::new(),
        });
    };
    let layout = decode_layout(&layout)?;
    let resolutions = resolve_layout(connection, &layout)?;
    Ok(LocalBlockSnapshot {
        identity_id: identity_id.to_owned(),
        identity_name,
        block_id: Some(block_id),
        revision: stored_u64(revision)?,
        layout,
        updated_at_ms: stored_u64(updated_at_ms)?,
        changed: false,
        resolutions,
    })
}

fn stored_u64(value: i64) -> Result<u64, LocalOfficeError> {
    value
        .try_into()
        .map_err(|_| LocalOfficeError::StoredLayoutInvalid)
}

fn decode_layout(value: &str) -> Result<LocalBlockLayout, LocalOfficeError> {
    if let Ok(tokens) = serde_json::from_str::<Vec<String>>(value) {
        return BlockLayout::decode(&tokens)
            .map(|layout| LocalBlockLayout::from_legacy(&layout))
            .map_err(|_| LocalOfficeError::StoredLayoutInvalid);
    }
    crate::office_block::decode_local_layout(value.as_bytes())
        .map_err(|_| LocalOfficeError::StoredLayoutInvalid)
}

#[derive(Clone, Copy)]
enum PackFailure {
    Missing,
    Corrupt,
}

fn resolve_layout(
    connection: &rusqlite::Connection,
    layout: &LocalBlockLayout,
) -> Result<Vec<LocalPropResolution>, LocalOfficeError> {
    let mut packs = HashMap::new();
    layout
        .objects()
        .iter()
        .map(|item| match resolve_item(connection, item, &mut packs)? {
            ItemResolution::Available(label) => Ok(LocalPropResolution::Available { label }),
            ItemResolution::Missing
            | ItemResolution::Corrupt
            | ItemResolution::FootprintMismatch => Ok(LocalPropResolution::Unavailable {
                digest_prefix: digest_prefix(&item.prop),
            }),
        })
        .collect()
}

fn validate_mutation(
    connection: &rusqlite::Connection,
    current: Option<&LocalBlockLayout>,
    proposed: &LocalBlockLayout,
) -> Result<(), LocalOfficeError> {
    let mut packs = HashMap::new();
    let mut retained = HashMap::<PropPlacement, usize>::new();
    if let Some(current) = current {
        for item in current.objects() {
            if !matches!(
                resolve_item(connection, item, &mut packs)?,
                ItemResolution::Available(_)
            ) {
                *retained.entry(item.clone()).or_default() += 1;
            }
        }
    }
    for item in proposed.objects() {
        let resolution = resolve_item(connection, item, &mut packs)?;
        if matches!(resolution, ItemResolution::Available(_)) {
            continue;
        }
        if let Some(count) = retained.get_mut(item).filter(|count| **count > 0) {
            *count -= 1;
            continue;
        }
        return Err(match resolution {
            ItemResolution::Corrupt => LocalOfficeError::PropCorrupt,
            ItemResolution::FootprintMismatch => LocalOfficeError::LayoutInvalid,
            ItemResolution::Missing => LocalOfficeError::PropNotFound,
            ItemResolution::Available(_) => unreachable!(),
        });
    }
    Ok(())
}

enum ItemResolution {
    Available(String),
    Missing,
    Corrupt,
    FootprintMismatch,
}

fn resolve_item(
    connection: &rusqlite::Connection,
    item: &PropPlacement,
    cache: &mut HashMap<String, Result<crate::office_prop::ValidatedPropPack, PackFailure>>,
) -> Result<ItemResolution, LocalOfficeError> {
    let (digest, key) =
        parse_prop_reference(&item.prop).ok_or(LocalOfficeError::StoredLayoutInvalid)?;
    if !cache.contains_key(digest) {
        let pack = if digest == BUILTIN_DIGEST {
            Ok(builtin_pack())
        } else {
            let row = connection
                .query_row(
                    "SELECT length(bytes), CASE WHEN length(bytes) <= ? THEN bytes ELSE NULL END FROM office_prop_packs WHERE digest = ?",
                    params![i64::try_from(crate::office_prop::PACK_INPUT_LIMIT).expect("pack bound fits SQLite"), digest],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<Vec<u8>>>(1)?)),
                )
                .optional()
                .map_err(|error| classify(error, "Resolve local Office prop pack"))?;
            match row {
                None => Err(PackFailure::Missing),
                Some((length, Some(bytes))) if length >= 0 => validate_pack(&bytes)
                    .ok()
                    .filter(|pack| pack.digest() == digest)
                    .ok_or(PackFailure::Corrupt),
                Some(_) => Err(PackFailure::Corrupt),
            }
        };
        cache.insert(digest.to_owned(), pack);
    }
    match cache.get(digest).expect("pack cache populated") {
        Ok(pack) => match pack.prop(key) {
            Some(prop)
                if prop.footprint.width == item.footprint_width
                    && prop.footprint.height == item.footprint_height =>
            {
                Ok(ItemResolution::Available(prop.label.clone()))
            }
            Some(_) => Ok(ItemResolution::FootprintMismatch),
            None => Ok(ItemResolution::Missing),
        },
        Err(PackFailure::Missing) => Ok(ItemResolution::Missing),
        Err(PackFailure::Corrupt) => Ok(ItemResolution::Corrupt),
    }
}

fn digest_prefix(reference: &str) -> String {
    reference
        .strip_prefix("sha256:")
        .and_then(|value| value.get(..12))
        .unwrap_or("000000000000")
        .to_owned()
}

fn current_time_ms() -> Result<u64, LocalOfficeError> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| {
            StorageError::new(StorageErrorCode::Unknown, "Read system clock failed")
                .caused_by(error)
        })?
        .as_millis()
        .try_into()
        .map_err(|error| {
            LocalOfficeError::Storage(
                StorageError::new(StorageErrorCode::Unknown, "System timestamp is too large")
                    .caused_by(error),
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestDirectory;
    use tmt_core::office_block::{Furniture, FurnitureAsset};

    fn insert_identity(storage: &Storage, id: &str, name: &str, lifetime: &str) {
        storage
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO identities (id, name, canonical_name, lifetime, created_at, updated_at) \
                 VALUES (?, ?, lower(?), ?, 'now', 'now')",
                params![id, name, name, lifetime],
            )
            .unwrap();
    }

    #[test]
    fn local_blocks_use_identity_uuid_cas_and_active_projection() {
        let directory = TestDirectory::new();
        let mut storage = Storage::open(directory.path.join("state.db")).unwrap();
        let first = "11111111-1111-4111-8111-111111111111";
        insert_identity(&storage, first, "Alice", "temporary");
        let missing = storage.show_local_block(first).unwrap();
        assert!(!missing.exists());
        assert_eq!(missing.revision, 0);

        let legacy_layout = BlockLayout::new(vec![Furniture {
            asset: FurnitureAsset::Desk,
            x: 1,
            y: 2,
            rotation: 0,
        }])
        .unwrap();
        let layout = LocalBlockLayout::from_legacy(&legacy_layout);
        let created = storage.apply_local_block(first, 0, &layout).unwrap();
        assert_eq!(created.revision, 1);
        let retried = storage.apply_local_block(first, 0, &layout).unwrap();
        assert_eq!(retried.revision, created.revision);
        assert_eq!(retried.layout, created.layout);
        assert!(!retried.changed);
        assert!(matches!(
            storage.apply_local_block(
                first,
                0,
                &LocalBlockLayout::new(Vec::new()).expect("empty layout is valid")
            ),
            Err(LocalOfficeError::RevisionConflict)
        ));

        storage
            .connection()
            .unwrap()
            .execute(
                "UPDATE identities SET retired_at_ms = 1 WHERE id = ?",
                [first],
            )
            .unwrap();
        assert!(matches!(
            storage.show_local_block(first),
            Err(LocalOfficeError::IdentityInactive)
        ));
        assert!(storage.list_active_local_blocks().unwrap().is_empty());

        let second = "22222222-2222-4222-8222-222222222222";
        insert_identity(&storage, second, "Alice", "saved");
        assert!(!storage.show_local_block(second).unwrap().exists());
        let replacement = storage.apply_local_block(second, 0, &layout).unwrap();
        assert_ne!(replacement.block_id, created.block_id);
        let active = storage.list_active_local_blocks().unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].identity_id, second);
        storage.close().unwrap();
    }
}
