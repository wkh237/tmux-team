use rusqlite::{Connection, params, types::Value};
use tmt_core::{
    binding::{BindingError, remove_identity, unbind_identity},
    identity::{IdentityReader, Lifetime, create_or_resolve},
};

use super::super::test_support::Fixture;
use super::endpoint::{EndpointFailure, FakeEndpoint, ProbeMode};

fn state_counts(connection: &Connection, identity_id: &str) -> (i64, i64, i64, i64, i64, i64) {
    connection
        .query_row(
            "SELECT
                (SELECT COUNT(*) FROM role_profiles WHERE identity_id = ?),
                (SELECT COUNT(*) FROM identity_preambles WHERE identity_id = ?),
                (SELECT COUNT(*) FROM preamble_counters WHERE identity_id = ?),
                (SELECT COUNT(*) FROM request_attempts WHERE identity_id = ?),
                (SELECT COUNT(*) FROM request_responses WHERE request_id = ?),
                (SELECT COUNT(*) FROM request_attention_identities WHERE identity_id = ?)",
            params![
                identity_id,
                identity_id,
                identity_id,
                identity_id,
                format!("request-{identity_id}"),
                identity_id,
            ],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .unwrap()
}

fn binding_rows(connection: &Connection, identity_id: &str) -> Vec<Vec<Value>> {
    let mut statement = connection
        .prepare("SELECT * FROM bindings WHERE identity_id = ? ORDER BY id")
        .unwrap();
    statement
        .query_map([identity_id], |row| {
            (0..row.as_ref().column_count())
                .map(|index| row.get(index))
                .collect::<rusqlite::Result<Vec<Value>>>()
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

fn seed_state(connection: &Connection, identity_id: &str) {
    let attempt_id = format!("attempt-{identity_id}");
    let request_id = format!("request-{identity_id}");
    connection
        .execute(
            "INSERT INTO role_profiles VALUES (?, 'role body', 'role-time')",
            [identity_id],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO identity_preambles VALUES (?, 'preamble body', 'preamble-time')",
            [identity_id],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO preamble_counters VALUES (?, 12, 123456789)",
            [identity_id],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO request_attention_identities VALUES (?, 7, 5)",
            [identity_id],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO request_attempts (
                attempt_id, request_id, identity_id, server_id, socket_path, server_pid,
                server_start_time, pane_id, pane_pid, wait_active, status, inject_preamble,
                cadence_reserved, prepared_at_ms, expires_at_ms, retention_days,
                retention_expires_at_ms
             ) VALUES (?, ?, ?, 'server', '/tmp/socket', 41, 'server-start', '%1', 99,
                0, 'sent', 0, 1, 100, 200, 7, 300)",
            params![attempt_id, request_id, identity_id],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO request_responses (
                request_id, attempt_id, server_id, socket_path, server_pid,
                server_start_time, pane_id, pane_pid, body, body_bytes, submitted_at_ms,
                response_expires_at_ms
             ) VALUES (?, ?, 'server', '/tmp/socket', 41, 'server-start', '%1', 99,
                'response body', 13, 150, 500)",
            params![request_id, attempt_id],
        )
        .unwrap();
}

#[test]
fn remove_unknown_or_unclearable_binding_fails_closed_without_mutating_state() {
    let fixture = Fixture::new();
    let mut storage = fixture.open();
    let mut endpoint = FakeEndpoint::new(&["%1"]);
    let identity =
        tmt_core::binding::bind_identity(&mut storage, &mut endpoint, "%1", "Alice", true)
            .unwrap()
            .identity;
    seed_state(storage.connection().unwrap(), &identity.id);
    let rows = binding_rows(storage.connection().unwrap(), &identity.id);
    let counts = state_counts(storage.connection().unwrap(), &identity.id);

    endpoint.probe_mode = ProbeMode::Unknown;
    let error = remove_identity(&mut storage, &mut endpoint, "Alice", true).unwrap_err();
    assert!(matches!(error, BindingError::Unverified));
    assert_eq!(endpoint.clear_calls, 0);
    assert_eq!(
        binding_rows(storage.connection().unwrap(), &identity.id),
        rows
    );
    assert_eq!(
        state_counts(storage.connection().unwrap(), &identity.id),
        counts
    );

    endpoint.probe_mode = ProbeMode::Live;
    endpoint.clear_result = false;
    let error = remove_identity(&mut storage, &mut endpoint, "Alice", true).unwrap_err();
    assert!(matches!(error, BindingError::Unverified));
    assert_eq!(
        binding_rows(storage.connection().unwrap(), &identity.id),
        rows
    );
    assert_eq!(
        state_counts(storage.connection().unwrap(), &identity.id),
        counts
    );

    endpoint.clear_result = true;
    endpoint.clear_failure = true;
    let error = remove_identity(&mut storage, &mut endpoint, "Alice", true).unwrap_err();
    assert!(matches!(
        error,
        BindingError::Endpoint(EndpointFailure("clear failed"))
    ));
    assert_eq!(
        binding_rows(storage.connection().unwrap(), &identity.id),
        rows
    );
    assert_eq!(
        state_counts(storage.connection().unwrap(), &identity.id),
        counts
    );
    storage.close().unwrap();
}

#[test]
fn unbind_retires_temporary_but_saved_offline_only_detaches() {
    let fixture = Fixture::new();
    let mut storage = fixture.open();
    let mut endpoint = FakeEndpoint::new(&["%1", "%2"]);
    let temporary =
        tmt_core::binding::bind_identity(&mut storage, &mut endpoint, "%1", "Temporary", false)
            .unwrap()
            .identity;
    let unbound = unbind_identity(&mut storage, &mut endpoint, "%1")
        .unwrap()
        .unwrap();
    assert!(unbound.retired);
    assert!(unbound.binding.is_some());
    assert!(storage.find_identity("temporary").unwrap().is_none());
    assert_eq!(unbound.identity.id, temporary.id);

    let saved = tmt_core::binding::bind_identity(&mut storage, &mut endpoint, "%2", "Saved", true)
        .unwrap()
        .identity;
    endpoint.pane_mut("%2").marker = None;
    let unbound = unbind_identity(&mut storage, &mut endpoint, "%2")
        .unwrap()
        .unwrap();
    assert!(!unbound.retired);
    assert!(unbound.binding.is_none());
    assert_eq!(unbound.identity.id, saved.id);
    assert!(storage.find_identity("saved").unwrap().is_some());
    assert_eq!(endpoint.clear_calls, 1);
    storage.close().unwrap();
}

#[test]
fn saved_remove_requires_confirmation_without_endpoint_io_and_force_removes_only_content() {
    let fixture = Fixture::new();
    let mut storage = fixture.open();
    let mut endpoint = FakeEndpoint::new(&[]);
    let identity = create_or_resolve(&mut storage, "Saved", Lifetime::Saved)
        .unwrap()
        .identity;
    seed_state(storage.connection().unwrap(), &identity.id);
    let calls = (
        endpoint.begin_calls,
        endpoint.current_calls,
        endpoint.probe_calls.len(),
        endpoint.clear_calls,
    );

    let error = remove_identity(&mut storage, &mut endpoint, "Saved", false).unwrap_err();
    assert!(matches!(error, BindingError::ConfirmationRequired));
    assert_eq!(
        calls,
        (
            endpoint.begin_calls,
            endpoint.current_calls,
            endpoint.probe_calls.len(),
            endpoint.clear_calls
        )
    );
    let removed = remove_identity(&mut storage, &mut endpoint, "Saved", true).unwrap();
    assert_eq!(removed.identity.id, identity.id);
    assert!(removed.binding.is_none());
    assert_eq!(
        state_counts(storage.connection().unwrap(), &identity.id),
        (0, 0, 1, 1, 1, 1)
    );
    assert!(storage.find_identity("saved").unwrap().is_none());
    let tombstone: Option<i64> = storage
        .connection()
        .unwrap()
        .query_row(
            "SELECT retired_at_ms FROM identities WHERE id = ?",
            [&identity.id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(tombstone.is_some());
    storage.close().unwrap();
}
