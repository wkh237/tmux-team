use crate::test_support::TestDirectory;
use tmt_core::{
    endpoint::ServerEvidence,
    limits::MAX_JS_SAFE_INTEGER,
    request::{Originator, PrepareRequest, RequestEndpoint, RequestRepository, RequestService},
};

use super::super::*;

fn endpoint() -> RequestEndpoint {
    RequestEndpoint {
        server: ServerEvidence {
            server_id: "server-id".into(),
            socket_path: "/tmp/tmt-request-test.sock".into(),
            server_pid: 41,
            server_start_time: "start".into(),
        },
        pane_id: "%1".into(),
        pane_pid: 42,
    }
}

fn seed_attempt(storage: &mut Storage, request_id: &str, attempt_id: &str) {
    let mut service = RequestService::new(storage, || 1_000);
    service
        .prepare(
            PrepareRequest {
                request_id: request_id.into(),
                message: "original prompt".into(),
                endpoint: endpoint(),
                wait: false,
                expires_at_ms: 2_000,
                originator: Originator::Unknown,
                recipient_identity_id: None,
                preamble: None,
            },
            attempt_id.into(),
            7,
        )
        .unwrap();
}

#[test]
fn context_keeps_scrubbed_prompt_expiry_marker() {
    let directory = TestDirectory::new();
    let database = directory.path.join("state").join("requests.db");
    let mut storage = Storage::open(database).unwrap();
    seed_attempt(&mut storage, "request-1", "attempt-1");

    storage
        .connection()
        .unwrap()
        .execute(
            "UPDATE request_attempts SET message_text = NULL, message_bytes = NULL WHERE request_id = ?",
            ["request-1"],
        )
        .unwrap();
    let context = storage
        .with_request_transaction(|records| records.find_context("request-1"))
        .unwrap()
        .unwrap();
    assert_eq!(context.message, None);
    assert_eq!(context.message_bytes, None);
    assert!(context.expires_at_ms.is_some());
    storage.close().unwrap();
}

#[test]
fn row_decoder_accepts_safe_maximum_and_rejects_out_of_range_values() {
    let directory = TestDirectory::new();
    let database = directory.path.join("state").join("requests.db");
    let mut storage = Storage::open(database).unwrap();
    seed_attempt(&mut storage, "request-1", "attempt-1");

    storage
        .connection()
        .unwrap()
        .execute(
            "UPDATE request_attempts SET prepared_at_ms = ? WHERE request_id = ?",
            rusqlite::params![MAX_JS_SAFE_INTEGER as i64, "request-1"],
        )
        .unwrap();
    assert_eq!(
        storage
            .with_request_transaction(|records| records.find_request("request-1"))
            .unwrap()
            .unwrap()
            .prepared_at_ms,
        MAX_JS_SAFE_INTEGER
    );

    for value in [MAX_JS_SAFE_INTEGER as i64 + 1, -1] {
        storage
            .connection()
            .unwrap()
            .execute(
                "UPDATE request_attempts SET prepared_at_ms = ? WHERE request_id = ?",
                rusqlite::params![value, "request-1"],
            )
            .unwrap();
        assert!(
            storage
                .with_request_transaction(|records| records.find_request("request-1"))
                .is_err()
        );
    }
    storage.close().unwrap();
}

#[test]
fn response_marker_mismatch_rolls_back_orphan_final_insert() {
    let directory = TestDirectory::new();
    let database = directory.path.join("state").join("requests.db");
    let mut storage = Storage::open(database).unwrap();
    seed_attempt(&mut storage, "request-1", "attempt-1");

    storage
        .connection()
        .unwrap()
        .execute(
            "UPDATE request_attempts SET response_submitted_at_ms = ? WHERE request_id = ?",
            rusqlite::params![1_i64, "request-1"],
        )
        .unwrap();
    let response = tmt_core::request::FinalResponse {
        request_id: "request-1".into(),
        attempt_id: "attempt-1".into(),
        endpoint: endpoint(),
        body: "final".into(),
        body_bytes: 5,
        submitted_at_ms: 1_500,
        response_expires_at_ms: 10_000,
    };
    let result: Result<(), StorageError> =
        storage.with_request_transaction(|records| records.create_response(&response));
    assert!(result.is_err());
    let count: i64 = storage
        .connection()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM request_responses WHERE request_id = ?",
            ["request-1"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    let marker: i64 = storage
        .connection()
        .unwrap()
        .query_row(
            "SELECT response_submitted_at_ms FROM request_attempts WHERE request_id = ?",
            ["request-1"],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(marker, 1);
    storage.close().unwrap();
}

#[test]
fn retained_cleanup_plan_uses_horizon_index_without_sort() {
    let directory = TestDirectory::new();
    let database = directory.path.join("state").join("requests.db");
    let mut storage = Storage::open(database).unwrap();
    let plan_sql = format!("EXPLAIN QUERY PLAN {}", super::DELETE_RETAINED_SQL);
    let details = {
        let mut statement = storage.connection().unwrap().prepare(&plan_sql).unwrap();
        statement
            .query_map(rusqlite::params![1_i64, 2_i64, 2_i64, 100_i64], |row| {
                row.get::<_, String>(3)
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    };
    assert!(
        details
            .iter()
            .any(|detail| detail.contains("request_attempts_retention_horizon"))
    );
    assert!(
        !details
            .iter()
            .any(|detail| detail.contains("USE TEMP B-TREE FOR ORDER BY"))
    );
    storage.close().unwrap();
}
