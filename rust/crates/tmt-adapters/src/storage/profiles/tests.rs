use super::super::*;
use crate::test_support::TestDirectory;
use rusqlite::{Connection, OpenFlags, params, types::Value};
use std::path::PathBuf;
use tmt_core::{
    identity::{Lifetime, create_or_resolve},
    profile::{self, ProfileKind, ProfileReader, normalize_content},
};

struct Fixture {
    _directory: TestDirectory,
    database: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let directory = TestDirectory::new();
        Self {
            database: directory.path.join("state").join("tmux-team.db"),
            _directory: directory,
        }
    }

    fn open(&self) -> Storage {
        Storage::open(&self.database).unwrap()
    }

    fn setup_connection(&self) -> Connection {
        Connection::open(&self.database).unwrap()
    }

    fn observe(&self) -> Connection {
        Connection::open_with_flags(&self.database, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
    }
}

fn dependent_snapshot(connection: &Connection, identity_id: &str) -> Vec<Vec<Vec<Value>>> {
    snapshot_queries(
        connection,
        identity_id,
        &[
            "SELECT * FROM role_profiles WHERE identity_id = ?",
            "SELECT * FROM identity_preambles WHERE identity_id = ?",
            "SELECT * FROM preamble_counters WHERE identity_id = ?",
            "SELECT * FROM bindings WHERE identity_id = ?",
        ],
    )
}

fn snapshot_queries(
    connection: &Connection,
    identity_id: &str,
    queries: &[&str],
) -> Vec<Vec<Vec<Value>>> {
    queries
        .iter()
        .map(|query| {
            let mut statement = connection.prepare(query).unwrap();
            statement
                .query_map([identity_id], |row| {
                    (0..row.as_ref().column_count())
                        .map(|index| row.get(index))
                        .collect::<rusqlite::Result<Vec<Value>>>()
                })
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        })
        .collect()
}

fn seed_binding_and_cadence(connection: &Connection, identity_id: &str) {
    connection
        .execute(
            "INSERT INTO bindings (
                id, identity_id, transport, pane_id, server_id, socket_path,
                server_pid, server_start_time, pane_pid, bound_at, last_verified_at
             ) VALUES (?, ?, 'tmux', '%1', 'server', '/tmp/tmux.sock', 41,
                'server-start', 42, 'bound', 'verified')",
            params!["binding", identity_id],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO preamble_counters (identity_id, reserved_count, updated_at_ms)
             VALUES (?, 7, 1234)",
            [identity_id],
        )
        .unwrap();
}

fn lifecycle_snapshot(connection: &Connection, identity_id: &str) -> Vec<Vec<Vec<Value>>> {
    snapshot_queries(
        connection,
        identity_id,
        &[
            "SELECT * FROM preamble_counters WHERE identity_id = ?",
            "SELECT * FROM bindings WHERE identity_id = ?",
        ],
    )
}

fn identity_lifetime(connection: &Connection, identity_id: &str) -> (String, Option<i64>) {
    connection
        .query_row(
            "SELECT lifetime, retired_at_ms FROM identities WHERE id = ?",
            [identity_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
}

#[test]
fn stores_role_and_preamble_independently_across_reopen_and_clear() {
    let fixture = Fixture::new();
    let mut storage = fixture.open();
    let alpha = create_or_resolve(&mut storage, "Alpha", Lifetime::Saved)
        .unwrap()
        .identity;
    let beta = create_or_resolve(&mut storage, "beta", Lifetime::Saved)
        .unwrap()
        .identity;
    let role = normalize_content("role\r\nbody").unwrap();
    let preamble = normalize_content("preamble body").unwrap();

    assert_eq!(
        profile::set_profile(&mut storage, &alpha, ProfileKind::Role, &role)
            .unwrap()
            .unwrap()
            .content,
        "role\nbody"
    );
    assert_eq!(
        profile::set_profile(&mut storage, &alpha, ProfileKind::Preamble, &preamble)
            .unwrap()
            .unwrap()
            .content,
        "preamble body"
    );
    assert_eq!(
        profile::set_profile(&mut storage, &beta, ProfileKind::Preamble, &preamble)
            .unwrap()
            .unwrap()
            .content,
        "preamble body"
    );
    assert_eq!(
        storage
            .find_profile(&alpha.id, ProfileKind::Role)
            .unwrap()
            .unwrap()
            .content,
        "role\nbody"
    );
    assert!(
        storage
            .find_profile(&beta.id, ProfileKind::Role)
            .unwrap()
            .is_none()
    );
    let listed = storage.list_preambles().unwrap();
    assert_eq!(
        listed
            .iter()
            .map(|(identity, _)| identity.canonical_name.as_str())
            .collect::<Vec<_>>(),
        ["alpha", "beta"]
    );
    assert_eq!(
        profile::clear_profile(&mut storage, &alpha, ProfileKind::Role).unwrap(),
        Some(true)
    );
    assert_eq!(
        profile::clear_profile(&mut storage, &alpha, ProfileKind::Role).unwrap(),
        Some(false)
    );
    assert_eq!(
        profile::clear_profile(&mut storage, &beta, ProfileKind::Preamble).unwrap(),
        Some(true)
    );
    assert_eq!(
        profile::clear_profile(&mut storage, &beta, ProfileKind::Preamble).unwrap(),
        Some(false)
    );
    assert!(
        storage
            .find_profile(&alpha.id, ProfileKind::Role)
            .unwrap()
            .is_none()
    );
    storage.close().unwrap();

    let mut reopened = fixture.open();
    assert!(
        reopened
            .find_profile(&alpha.id, ProfileKind::Role)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        reopened
            .find_profile(&alpha.id, ProfileKind::Preamble)
            .unwrap()
            .unwrap()
            .content,
        "preamble body"
    );
    assert_eq!(reopened.list_preambles().unwrap().len(), 1);
    reopened.close().unwrap();

    let verification = fixture.observe();
    let role_count: i64 = verification
        .query_row(
            "SELECT COUNT(*) FROM role_profiles WHERE identity_id = ?",
            [&alpha.id],
            |row| row.get(0),
        )
        .unwrap();
    let preamble_count: i64 = verification
        .query_row("SELECT COUNT(*) FROM identity_preambles", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(role_count, 0);
    assert_eq!(preamble_count, 1);
}

#[test]
fn stale_retired_or_replaced_observations_do_not_write_or_touch_lifecycle_state() {
    let fixture = Fixture::new();
    let mut storage = fixture.open();
    let old = create_or_resolve(&mut storage, "Stale", Lifetime::Saved)
        .unwrap()
        .identity;
    let content = normalize_content("old profile").unwrap();
    profile::set_profile(&mut storage, &old, ProfileKind::Role, &content)
        .unwrap()
        .unwrap();
    profile::set_profile(&mut storage, &old, ProfileKind::Preamble, &content)
        .unwrap()
        .unwrap();
    {
        let connection = fixture.setup_connection();
        seed_binding_and_cadence(&connection, &old.id);
        connection
            .execute(
                "UPDATE identities SET retired_at_ms = 1000 WHERE id = ?",
                [&old.id],
            )
            .unwrap();
    }
    let replacement = create_or_resolve(&mut storage, "Stale", Lifetime::Saved)
        .unwrap()
        .identity;
    assert_ne!(old.id, replacement.id);
    let before_old = dependent_snapshot(&fixture.observe(), &old.id);
    let before_replacement = dependent_snapshot(&fixture.observe(), &replacement.id);

    assert!(
        storage
            .find_profile(&old.id, ProfileKind::Role)
            .unwrap()
            .is_none()
    );
    assert_eq!(
        profile::set_profile(&mut storage, &old, ProfileKind::Role, &content).unwrap(),
        None
    );
    assert_eq!(
        profile::clear_profile(&mut storage, &old, ProfileKind::Preamble).unwrap(),
        None
    );
    assert!(
        storage
            .find_profile(&replacement.id, ProfileKind::Role)
            .unwrap()
            .is_none()
    );
    storage.close().unwrap();

    let verification = fixture.observe();
    assert_eq!(dependent_snapshot(&verification, &old.id), before_old);
    assert_eq!(
        dependent_snapshot(&verification, &replacement.id),
        before_replacement
    );
    let old_lifetime: (String, Option<i64>) = verification
        .query_row(
            "SELECT lifetime, retired_at_ms FROM identities WHERE id = ?",
            [&old.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let replacement_lifetime: (String, Option<i64>) = verification
        .query_row(
            "SELECT lifetime, retired_at_ms FROM identities WHERE id = ?",
            [&replacement.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(old_lifetime, ("saved".into(), Some(1000)));
    assert_eq!(replacement_lifetime, ("saved".into(), None));
}

#[test]
fn temporary_profile_overwrites_preserve_lifetime_cadence_and_binding() {
    let fixture = Fixture::new();
    let mut storage = fixture.open();
    let temporary = create_or_resolve(&mut storage, "Temporary", Lifetime::Temporary)
        .unwrap()
        .identity;
    let initial = normalize_content("initial").unwrap();
    profile::set_profile(&mut storage, &temporary, ProfileKind::Role, &initial)
        .unwrap()
        .unwrap();
    profile::set_profile(&mut storage, &temporary, ProfileKind::Preamble, &initial)
        .unwrap()
        .unwrap();
    {
        let connection = fixture.setup_connection();
        seed_binding_and_cadence(&connection, &temporary.id);
    }
    let before = fixture.observe();
    let before_lifecycle = lifecycle_snapshot(&before, &temporary.id);
    let before_identity = identity_lifetime(&before, &temporary.id);
    drop(before);

    let replacement = normalize_content("replacement\r\nbody").unwrap();
    assert_eq!(
        profile::set_profile(&mut storage, &temporary, ProfileKind::Role, &replacement)
            .unwrap()
            .unwrap()
            .content,
        "replacement\nbody"
    );
    assert_eq!(
        profile::set_profile(
            &mut storage,
            &temporary,
            ProfileKind::Preamble,
            &replacement
        )
        .unwrap()
        .unwrap()
        .content,
        "replacement\nbody"
    );
    storage.close().unwrap();

    let verification = fixture.observe();
    assert_eq!(
        lifecycle_snapshot(&verification, &temporary.id),
        before_lifecycle
    );
    assert_eq!(
        identity_lifetime(&verification, &temporary.id),
        before_identity
    );
    assert_eq!(
        verification
            .query_row(
                "SELECT content FROM role_profiles WHERE identity_id = ?",
                [&temporary.id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        "replacement\nbody"
    );
    assert_eq!(
        verification
            .query_row(
                "SELECT content FROM identity_preambles WHERE identity_id = ?",
                [&temporary.id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        "replacement\nbody"
    );
}
