use super::support::{
    DAY_MS, Fixture, NOW_MS, count_rows, endpoint, preamble_count, prepare_input, service,
};
use crate::storage::{Storage, StorageError};
use std::{path::Path, sync::mpsc, thread, time::Duration};
use tmt_core::request::{
    FinalResponse, Originator, PreambleReservation, PrepareRequest, PreparedRequest, RequestError,
    RequestService, ResponseRejection, SubmitResponse,
};

type Operation<T> = Box<dyn FnOnce(&mut Storage) -> T + Send>;

/// Open before racing: this targets request transactions, not cold-WAL startup.
/// Scoped workers finish before fixture deletion; channel waits are bounded.
fn concurrent_pair<T: Send>(database: &Path, operations: [Operation<T>; 2]) -> [T; 2] {
    let connections = [
        Storage::open(database).unwrap(),
        Storage::open(database).unwrap(),
    ];
    thread::scope(|scope| {
        let mut starts = Vec::new();
        let mut results = Vec::new();
        let mut handles = Vec::new();
        for (mut storage, operation) in connections.into_iter().zip(operations) {
            let (start_tx, start_rx) = mpsc::sync_channel(1);
            let (result_tx, result_rx) = mpsc::sync_channel(1);
            starts.push(start_tx);
            results.push(result_rx);
            handles.push(scope.spawn(move || {
                start_rx
                    .recv_timeout(Duration::from_secs(10))
                    .expect("request worker start");
                let result = operation(&mut storage);
                storage.close().expect("close request worker storage");
                assert!(
                    result_tx.send(result).is_ok(),
                    "request worker receiver disappeared"
                );
            }));
        }
        for start in starts {
            start.send(()).unwrap();
        }
        let values: Vec<T> = results
            .into_iter()
            .map(|result| {
                result
                    .recv_timeout(Duration::from_secs(15))
                    .expect("bounded request worker result")
            })
            .collect();
        for handle in handles {
            handle.join().expect("request worker panicked");
        }
        values.try_into().ok().expect("exactly two worker results")
    })
}

#[test]
fn concurrent_prepare_connections_serialize_cadence_and_preserve_both_attempts() {
    let fixture = Fixture::new();
    let operations: [Operation<Result<PreparedRequest, RequestError<StorageError>>>; 2] =
        ["a", "b"].map(|suffix| {
            let identity_id = fixture.identity_id.clone();
            Box::new(move |storage: &mut Storage| {
                let input = PrepareRequest {
                    request_id: format!("request-{suffix}"),
                    message: format!("prompt-{suffix}"),
                    endpoint: endpoint("%60", 160),
                    wait: true,
                    expires_at_ms: NOW_MS + 3_600_001,
                    originator: Originator::Unknown,
                    recipient_identity_id: Some(identity_id.clone()),
                    preamble: Some(PreambleReservation {
                        identity_id,
                        every: 3,
                    }),
                };
                RequestService::new(storage, || NOW_MS).prepare(
                    input,
                    format!("attempt-{suffix}"),
                    7,
                )
            }) as Operation<_>
        });
    let prepared = concurrent_pair(&fixture.database, operations).map(Result::unwrap);
    assert_eq!(prepared.iter().filter(|p| p.inject_preamble).count(), 1);
    assert_eq!(
        prepared
            .iter()
            .filter(|p| p.previous_request_id.is_some())
            .count(),
        1
    );
    assert_eq!(preamble_count(&fixture.database, &fixture.identity_id), 2);
    let oracle = rusqlite::Connection::open_with_flags(
        &fixture.database,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let rows: Vec<(String, i64, i64, String)> = oracle.prepare(
        "SELECT attempt_id, inject_preamble, cadence_reserved, status FROM request_attempts ORDER BY attempt_id",
    ).unwrap().query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))).unwrap().collect::<rusqlite::Result<_>>().unwrap();
    assert_eq!(
        rows.iter().map(|r| r.0.as_str()).collect::<Vec<_>>(),
        ["attempt-a", "attempt-b"]
    );
    assert_eq!(rows.iter().filter(|r| r.1 == 1).count(), 1);
    assert!(rows.iter().all(|r| r.2 == 1 && r.3 == "prepared"));
}

#[test]
fn identical_and_conflicting_final_writers_keep_one_body_marker_and_revision() {
    for bodies in [["same", "same"], ["first", "second"]] {
        let mut fixture = Fixture::new();
        let input = prepare_input(
            &fixture,
            "final-race",
            endpoint("%61", 161),
            false,
            NOW_MS + 1,
            Originator::Explicit(fixture.identity_id.clone()),
            false,
        );
        service(&mut fixture)
            .prepare(input, "final-race-attempt".into(), 7)
            .unwrap();
        service(&mut fixture)
            .begin_send("final-race-attempt")
            .unwrap();
        let operations: [Operation<Result<FinalResponse, RequestError<StorageError>>>; 2] = [0, 1]
            .map(|index| {
                Box::new(move |storage: &mut Storage| {
                    RequestService::new(storage, || NOW_MS + 10 + index as u64).submit_response(
                        SubmitResponse {
                            request_id: "final-race".into(),
                            attempt_id: "final-race-attempt".into(),
                            endpoint: endpoint("%61", 161),
                            body: bodies[index].into(),
                        },
                    )
                }) as Operation<_>
            });
        let results = concurrent_pair(&fixture.database, operations);
        let winners: Vec<_> = results.iter().filter_map(|r| r.as_ref().ok()).collect();
        if bodies[0] == bodies[1] {
            assert_eq!(winners.len(), 2);
            assert_eq!(winners[0], winners[1]);
        } else {
            assert_eq!(winners.len(), 1);
            assert_eq!(
                results
                    .iter()
                    .filter(|r| matches!(
                        r,
                        Err(RequestError::Response(ResponseRejection::Conflict))
                    ))
                    .count(),
                1
            );
        }
        assert_eq!(count_rows(&fixture.database, "request_responses"), 1);
        let oracle = rusqlite::Connection::open_with_flags(
            &fixture.database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        let stored: (String, i64, i64, i64, i64) = oracle
            .query_row(
                "SELECT r.body, r.submitted_at_ms, a.response_submitted_at_ms,
                    a.attention_revision, s.latest_revision
             FROM request_responses r JOIN request_attempts a USING(request_id)
             JOIN request_attention_identities s ON s.identity_id = a.originator_identity_id",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            stored,
            (
                winners[0].body.clone(),
                winners[0].submitted_at_ms as i64,
                winners[0].submitted_at_ms as i64,
                2,
                2
            )
        );
    }
}

#[test]
fn cleanup_and_late_submission_serialize_without_refund_or_lost_final() {
    let mut fixture = Fixture::new();
    let input = prepare_input(
        &fixture,
        "cleanup-race",
        endpoint("%62", 162),
        true,
        NOW_MS + 1,
        Originator::Unknown,
        true,
    );
    service(&mut fixture)
        .prepare(input, "cleanup-race-attempt".into(), 1)
        .unwrap();
    service(&mut fixture)
        .begin_send("cleanup-race-attempt")
        .unwrap();
    let now = NOW_MS + 6 * DAY_MS + 10;
    let results = concurrent_pair(
        &fixture.database,
        [
            Box::new(move |storage| {
                RequestService::new(storage, || now)
                    .cleanup()
                    .map(|()| None)
            }),
            Box::new(move |storage| {
                RequestService::new(storage, || now)
                    .submit_response(SubmitResponse {
                        request_id: "cleanup-race".into(),
                        attempt_id: "cleanup-race-attempt".into(),
                        endpoint: endpoint("%62", 162),
                        body: "late final".into(),
                    })
                    .map(Some)
            }),
        ],
    )
    .map(Result::unwrap);
    assert!(results[0].is_none());
    let final_response = results[1].as_ref().unwrap();
    assert_eq!(preamble_count(&fixture.database, &fixture.identity_id), 1);
    let oracle = rusqlite::Connection::open_with_flags(
        &fixture.database,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let state: (String, i64, Option<String>, i64) = oracle.query_row(
        "SELECT status, wait_active, message_text, response_submitted_at_ms FROM request_attempts WHERE request_id = 'cleanup-race'",
        [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).unwrap();
    assert_eq!(state, ("uncertain".into(), 0, None, now as i64));
    drop(oracle);
    fixture.set_now(NOW_MS + 7 * DAY_MS);
    assert_eq!(
        service(&mut fixture)
            .get_response("cleanup-race")
            .unwrap()
            .as_ref(),
        Some(final_response)
    );
}
