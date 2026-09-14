//! UUID-owned local Office presentation profile persistence and CAS policy.

use rusqlite::{OptionalExtension, params};
use tmt_core::office_profile::{LocalProfile, MAX_REVISION, deterministic_default};

use super::{
    Storage, StorageError, StorageErrorCode, errors::classify,
    identities::with_immediate_transaction,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalProfileSnapshot {
    pub identity_id: String,
    pub identity_name: String,
    pub exists: bool,
    pub revision: u64,
    pub profile: LocalProfile,
    pub updated_at_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalProfileMutation {
    pub snapshot: LocalProfileSnapshot,
    pub changed: bool,
}

#[derive(Debug)]
pub enum LocalProfileError {
    Storage(StorageError),
    IdentityInactive,
    RevisionConflict,
    RevisionExhausted,
    ProfileInvalid,
    StoredProfileInvalid,
}

impl From<StorageError> for LocalProfileError {
    fn from(value: StorageError) -> Self {
        Self::Storage(value)
    }
}

impl std::fmt::Display for LocalProfileError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Storage(_) => "Could not access local Office profile storage.",
            Self::IdentityInactive => "The selected identity is not active.",
            Self::RevisionConflict => "The local Office profile changed.",
            Self::RevisionExhausted => "The local Office profile revision is exhausted.",
            Self::ProfileInvalid => "The local Office profile is invalid.",
            Self::StoredProfileInvalid => "The stored local Office profile is invalid.",
        })
    }
}
impl std::error::Error for LocalProfileError {}

impl Storage {
    pub fn show_local_profile(
        &self,
        identity_id: &str,
    ) -> Result<LocalProfileSnapshot, LocalProfileError> {
        let connection = self.connection()?;
        let identity_name = connection
            .query_row(
                "SELECT name FROM identities WHERE id = ? AND retired_at_ms IS NULL",
                [identity_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| classify(error, "Read local Office profile identity"))?
            .ok_or(LocalProfileError::IdentityInactive)?;
        let stored = connection.query_row(
            "SELECT revision, profile, updated_at_ms FROM office_local_profiles WHERE identity_id = ?",
            [identity_id], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?)),
        ).optional().map_err(|error| classify(error, "Read local Office profile"))?;
        snapshot(identity_id, identity_name, stored)
    }

    pub fn list_active_local_profiles(
        &self,
    ) -> Result<Vec<LocalProfileSnapshot>, LocalProfileError> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare(
                "SELECT i.id, i.name, p.revision, p.profile, p.updated_at_ms FROM identities i \
             LEFT JOIN office_local_profiles p ON p.identity_id = i.id \
             WHERE i.retired_at_ms IS NULL ORDER BY i.canonical_name COLLATE BINARY",
            )
            .map_err(|error| classify(error, "Prepare active local Office profiles"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                ))
            })
            .map_err(|error| classify(error, "List active local Office profiles"))?;
        rows.map(|row| {
            let (id, name, revision, profile, updated) =
                row.map_err(|error| classify(error, "Read active local Office profile"))?;
            snapshot(
                &id,
                name,
                revision
                    .zip(profile)
                    .zip(updated)
                    .map(|((r, p), u)| (r, p, u)),
            )
        })
        .collect()
    }

    pub fn apply_local_profile(
        &mut self,
        identity_id: &str,
        expected_revision: u64,
        profile: &LocalProfile,
    ) -> Result<LocalProfileMutation, LocalProfileError> {
        profile
            .validate()
            .map_err(|_| LocalProfileError::ProfileInvalid)?;
        let encoded = crate::office_profile_wire::encode_value(profile).to_string();
        with_immediate_transaction(self, "local Office profile", |transaction| {
            let identity_name = transaction
                .query_row(
                    "SELECT name FROM identities WHERE id = ? AND retired_at_ms IS NULL",
                    [identity_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| classify(error, "Revalidate local Office profile identity"))?
                .ok_or(LocalProfileError::IdentityInactive)?;
            let current = transaction.query_row(
                "SELECT revision, profile, updated_at_ms FROM office_local_profiles WHERE identity_id = ?", [identity_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?)),
            ).optional().map_err(|error| classify(error, "Read local Office profile revision"))?;
            match current {
                None if expected_revision == 0 => {
                    let now = current_time_ms()?;
                    transaction.execute(
                        "INSERT INTO office_local_profiles (identity_id, revision, profile, updated_at_ms) VALUES (?, 1, ?, ?)",
                        params![identity_id, encoded, i64::try_from(now).expect("timestamp fits SQLite")],
                    ).map_err(|error| classify(error, "Create local Office profile"))?;
                    Ok(LocalProfileMutation {
                        snapshot: LocalProfileSnapshot {
                            identity_id: identity_id.into(),
                            identity_name,
                            exists: true,
                            revision: 1,
                            profile: profile.clone(),
                            updated_at_ms: Some(now),
                        },
                        changed: true,
                    })
                }
                None => Err(LocalProfileError::RevisionConflict),
                Some((revision, stored, updated))
                    if expected_revision.checked_add(1) == Some(stored_u64(revision)?)
                        && stored == encoded =>
                {
                    Ok(LocalProfileMutation {
                        snapshot: LocalProfileSnapshot {
                            identity_id: identity_id.into(),
                            identity_name,
                            exists: true,
                            revision: stored_u64(revision)?,
                            profile: profile.clone(),
                            updated_at_ms: Some(stored_u64(updated)?),
                        },
                        changed: false,
                    })
                }
                Some((revision, stored, updated))
                    if stored_u64(revision)? == expected_revision && stored == encoded =>
                {
                    Ok(LocalProfileMutation {
                        snapshot: LocalProfileSnapshot {
                            identity_id: identity_id.into(),
                            identity_name,
                            exists: true,
                            revision: stored_u64(revision)?,
                            profile: profile.clone(),
                            updated_at_ms: Some(stored_u64(updated)?),
                        },
                        changed: false,
                    })
                }
                Some((revision, _, _)) if stored_u64(revision)? != expected_revision => {
                    Err(LocalProfileError::RevisionConflict)
                }
                Some((revision, _, _)) if stored_u64(revision)? < MAX_REVISION => {
                    let now = current_time_ms()?;
                    let revision = stored_u64(revision)?;
                    let next = revision + 1;
                    transaction.execute(
                        "UPDATE office_local_profiles SET revision = ?, profile = ?, updated_at_ms = ? WHERE identity_id = ? AND revision = ? AND EXISTS (SELECT 1 FROM identities WHERE id = ? AND retired_at_ms IS NULL)",
                        params![i64::try_from(next).unwrap(), encoded, i64::try_from(now).unwrap(), identity_id, i64::try_from(revision).unwrap(), identity_id],
                    ).map_err(|error| classify(error, "Update local Office profile"))?;
                    Ok(LocalProfileMutation {
                        snapshot: LocalProfileSnapshot {
                            identity_id: identity_id.into(),
                            identity_name,
                            exists: true,
                            revision: next,
                            profile: profile.clone(),
                            updated_at_ms: Some(now),
                        },
                        changed: true,
                    })
                }
                Some(_) => Err(LocalProfileError::RevisionExhausted),
            }
        })
    }
}

fn snapshot(
    identity_id: &str,
    identity_name: String,
    stored: Option<(i64, String, i64)>,
) -> Result<LocalProfileSnapshot, LocalProfileError> {
    match stored {
        None => Ok(LocalProfileSnapshot {
            identity_id: identity_id.into(),
            identity_name,
            exists: false,
            revision: 0,
            profile: deterministic_default(identity_id)
                .map_err(|_| LocalProfileError::StoredProfileInvalid)?,
            updated_at_ms: None,
        }),
        Some((revision, encoded, updated)) => {
            let profile = serde_json::from_str(&encoded)
                .map_err(|_| LocalProfileError::StoredProfileInvalid)
                .and_then(|value| {
                    crate::office_profile_wire::decode_value(value)
                        .map_err(|_| LocalProfileError::StoredProfileInvalid)
                })?;
            Ok(LocalProfileSnapshot {
                identity_id: identity_id.into(),
                identity_name,
                exists: true,
                revision: stored_u64(revision)?,
                profile,
                updated_at_ms: Some(stored_u64(updated)?),
            })
        }
    }
}

fn stored_u64(value: i64) -> Result<u64, LocalProfileError> {
    value
        .try_into()
        .map_err(|_| LocalProfileError::StoredProfileInvalid)
}
fn current_time_ms() -> Result<u64, LocalProfileError> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| {
            StorageError::new(StorageErrorCode::Unknown, "Read system clock failed")
                .caused_by(error)
        })?
        .as_millis()
        .try_into()
        .map_err(|error| {
            LocalProfileError::Storage(
                StorageError::new(StorageErrorCode::Unknown, "System timestamp is too large")
                    .caused_by(error),
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TestDirectory;

    fn identity(storage: &Storage, id: &str, name: &str) {
        storage.connection().unwrap().execute(
            "INSERT INTO identities (id, name, canonical_name, lifetime, created_at, updated_at) VALUES (?, ?, lower(?), 'saved', 'now', 'now')",
            params![id, name, name],
        ).unwrap();
    }

    #[test]
    fn default_is_virtual_and_cas_preserves_noop_and_exact_retry_timestamp() {
        let directory = TestDirectory::new();
        let mut storage = Storage::open(directory.path.join("profile.db")).unwrap();
        let id = "01020304-1111-4111-8111-111111111111";
        identity(&storage, id, "Alice");
        storage.connection().unwrap().execute(
            "INSERT INTO bindings (id, identity_id, transport, pane_id, server_id, socket_path, server_pid, server_start_time, pane_pid, bound_at, last_verified_at) VALUES ('binding', ?, 'tmux', '%1', 'server', '/tmp/server.sock', 1, 'start', 2, 'now', 'now')",
            [id],
        ).unwrap();
        storage.connection().unwrap().execute(
            "INSERT INTO role_profiles (identity_id, content, updated_at) VALUES (?, 'architect', 'now')",
            [id],
        ).unwrap();
        let missing = storage.show_local_profile(id).unwrap();
        assert!(!missing.exists);
        assert_eq!(missing.revision, 0);
        assert_eq!(
            storage
                .connection()
                .unwrap()
                .query_row("SELECT count(*) FROM office_local_profiles", [], |row| row
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            0
        );

        let created = storage
            .apply_local_profile(id, 0, &missing.profile)
            .unwrap();
        assert!(created.changed);
        assert_eq!(created.snapshot.revision, 1);
        let created_at = created.snapshot.updated_at_ms;
        assert_eq!(
            storage
                .apply_local_profile(id, 0, &missing.profile)
                .unwrap(),
            LocalProfileMutation {
                changed: false,
                snapshot: created.snapshot.clone(),
            }
        );
        assert_eq!(
            storage
                .apply_local_profile(id, 1, &missing.profile)
                .unwrap(),
            LocalProfileMutation {
                changed: false,
                snapshot: created.snapshot.clone(),
            }
        );
        assert_eq!(created.snapshot.updated_at_ms, created_at);

        let mut changed = missing.profile.clone();
        changed.description = "Architecture review".into();
        let updated = storage.apply_local_profile(id, 1, &changed).unwrap();
        assert!(updated.changed);
        assert_eq!(updated.snapshot.revision, 2);
        assert_eq!(
            storage
                .connection()
                .unwrap()
                .query_row(
                    "SELECT content FROM role_profiles WHERE identity_id = ?",
                    [id],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "architect"
        );
        assert!(matches!(
            storage.apply_local_profile(id, 1, &missing.profile),
            Err(LocalProfileError::RevisionConflict)
        ));
        storage
            .connection()
            .unwrap()
            .execute(
                "UPDATE office_local_profiles SET revision = ? WHERE identity_id = ?",
                params![i64::try_from(MAX_REVISION).unwrap(), id],
            )
            .unwrap();
        let maximum = storage.show_local_profile(id).unwrap();
        assert_eq!(maximum.revision, MAX_REVISION);
        assert_eq!(
            storage
                .apply_local_profile(id, MAX_REVISION, &maximum.profile)
                .unwrap(),
            LocalProfileMutation {
                changed: false,
                snapshot: maximum,
            }
        );
        assert!(matches!(
            storage.apply_local_profile(id, MAX_REVISION, &missing.profile),
            Err(LocalProfileError::RevisionExhausted)
        ));
    }

    #[test]
    fn retirement_hides_but_retains_profile_and_same_name_replacement_inherits_nothing() {
        let directory = TestDirectory::new();
        let mut storage = Storage::open(directory.path.join("retirement.db")).unwrap();
        let old = "11111111-1111-4111-8111-111111111111";
        identity(&storage, old, "Alice");
        let default = storage.show_local_profile(old).unwrap().profile;
        storage.apply_local_profile(old, 0, &default).unwrap();
        storage
            .connection()
            .unwrap()
            .execute(
                "UPDATE identities SET retired_at_ms = 1 WHERE id = ?",
                [old],
            )
            .unwrap();
        assert!(matches!(
            storage.show_local_profile(old),
            Err(LocalProfileError::IdentityInactive)
        ));
        assert_eq!(
            storage
                .connection()
                .unwrap()
                .query_row(
                    "SELECT count(*) FROM office_local_profiles WHERE identity_id = ?",
                    [old],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );

        let replacement = "22222222-2222-4222-8222-222222222222";
        identity(&storage, replacement, "Alice");
        let snapshot = storage.show_local_profile(replacement).unwrap();
        assert!(!snapshot.exists);
        assert_ne!(snapshot.identity_id, old);
        assert_eq!(
            storage.list_active_local_profiles().unwrap(),
            vec![snapshot]
        );
    }
}
