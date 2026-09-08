use super::support::{
    Fixture, NOW_MS, count_rows, endpoint, preamble_count, prepare_input, service,
};
use tmt_core::request::{AttemptStatus, Originator, RequestError, Settlement};

#[test]
fn waiter_release_is_idempotent_isolated_and_does_not_cancel_delivery() {
    let mut fixture = Fixture::new();
    for id in ["first", "second"] {
        let input = prepare_input(
            &fixture,
            id,
            endpoint("%80", 180),
            true,
            NOW_MS + 3_600_001,
            Originator::Unknown,
            false,
        );
        service(&mut fixture).prepare(input, id.into(), 7).unwrap();
        service(&mut fixture).begin_send(id).unwrap();
    }
    service(&mut fixture).release_wait("first").unwrap();
    fixture.set_now(NOW_MS + 10);
    service(&mut fixture).release_wait("first").unwrap();
    service(&mut fixture).release_wait("absent").unwrap();
    service(&mut fixture)
        .settle("first", Settlement::Sent)
        .unwrap();
    fixture.set_now(NOW_MS + 20);
    service(&mut fixture)
        .settle("first", Settlement::Sent)
        .unwrap();
    assert!(matches!(
        service(&mut fixture).settle("first", Settlement::Uncertain),
        Err(RequestError::StateInvalid)
    ));
    let oracle = rusqlite::Connection::open_with_flags(
        &fixture.database,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    type WaiterState = (String, String, i64, Option<i64>, Option<i64>);
    let rows: Vec<WaiterState> = oracle
        .prepare(
            "SELECT attempt_id, status, wait_active, wait_released_at_ms, settled_at_ms
         FROM request_attempts ORDER BY attempt_id",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(
        rows,
        [
            (
                "first".into(),
                "sent".into(),
                0,
                Some(NOW_MS as i64),
                Some((NOW_MS + 10) as i64)
            ),
            ("second".into(), "sending".into(), 1, None, None),
        ]
    );
}

#[test]
fn proven_unsent_failure_refunds_once_and_expired_send_stays_uncertain() {
    let mut fixture = Fixture::new();
    let first_input = prepare_input(
        &fixture,
        "request-proven-failure",
        endpoint("%1", 101),
        true,
        NOW_MS + 1,
        Originator::Unknown,
        true,
    );
    let first = {
        let mut requests = service(&mut fixture);
        requests
            .prepare(first_input, "attempt-proven-failure".into(), 7)
            .expect("prepare proven-failure request")
    };
    assert_eq!(preamble_count(&fixture.database, &fixture.identity_id), 1);

    {
        let mut requests = service(&mut fixture);
        requests
            .settle(&first.attempt_id, Settlement::DefinitelyFailed)
            .expect("settle proven failure");
        assert!(
            requests
                .settle(&first.attempt_id, Settlement::DefinitelyFailed)
                .is_ok()
        );
        assert_eq!(
            requests
                .get_attempt(&first.attempt_id)
                .expect("read failed attempt")
                .expect("failed attempt retained")
                .status,
            AttemptStatus::DefinitelyFailed
        );
    }
    assert_eq!(preamble_count(&fixture.database, &fixture.identity_id), 0);

    let sending_input = prepare_input(
        &fixture,
        "request-expired-send",
        endpoint("%2", 102),
        true,
        NOW_MS + 2 * 3_600_000,
        Originator::Unknown,
        true,
    );
    let sending = {
        let mut requests = service(&mut fixture);
        requests
            .prepare(sending_input, "attempt-expired-send".into(), 7)
            .expect("prepare expired-send request")
    };
    {
        let mut requests = service(&mut fixture);
        requests
            .begin_send(&sending.attempt_id)
            .expect("begin sending");
    }
    fixture.set_now(NOW_MS + 2 * 3_600_000 + 1);
    {
        let mut requests = service(&mut fixture);
        requests.cleanup().expect("cleanup expired sending");
        let attempt = requests
            .get_attempt(&sending.attempt_id)
            .expect("read uncertain attempt")
            .expect("uncertain attempt retained");
        assert_eq!(attempt.status, AttemptStatus::Uncertain);
        assert!(attempt.wait_released_at_ms.is_some());
        assert!(attempt.cadence_reserved);
        assert!(matches!(
            requests.settle(&sending.attempt_id, Settlement::DefinitelyFailed),
            Err(RequestError::StateInvalid)
        ));
    }
    assert_eq!(preamble_count(&fixture.database, &fixture.identity_id), 1);
}

#[test]
fn duplicate_preparation_rolls_back_attempt_cadence_and_attention_revision() {
    let mut fixture = Fixture::new();
    let first_input = prepare_input(
        &fixture,
        "request-duplicate",
        endpoint("%3", 103),
        false,
        NOW_MS + 1,
        Originator::Explicit(fixture.identity_id.clone()),
        true,
    );
    {
        let mut requests = service(&mut fixture);
        requests
            .prepare(first_input, "attempt-duplicate-original".into(), 7)
            .expect("prepare original request");
    }
    let before_attempts = count_rows(&fixture.database, "request_attempts");
    let before_cadence = preamble_count(&fixture.database, &fixture.identity_id);
    let connection = rusqlite::Connection::open(&fixture.database).expect("open SQL oracle");
    let before_attention: i64 = connection
        .query_row(
            "SELECT latest_revision FROM request_attention_identities WHERE identity_id = ?",
            [&fixture.identity_id],
            |row| row.get(0),
        )
        .expect("read attention state");
    drop(connection);
    let duplicate_input = prepare_input(
        &fixture,
        "request-duplicate",
        endpoint("%4", 104),
        false,
        NOW_MS + 1,
        Originator::Explicit(fixture.identity_id.clone()),
        true,
    );
    let result = {
        let mut requests = service(&mut fixture);
        requests.prepare(duplicate_input, "attempt-duplicate-new".into(), 7)
    };
    assert!(result.is_err());
    assert_eq!(
        count_rows(&fixture.database, "request_attempts"),
        before_attempts
    );
    assert_eq!(
        preamble_count(&fixture.database, &fixture.identity_id),
        before_cadence
    );
    let connection = rusqlite::Connection::open(&fixture.database).expect("reopen SQL oracle");
    let attention: i64 = connection
        .query_row(
            "SELECT latest_revision FROM request_attention_identities WHERE identity_id = ?",
            [&fixture.identity_id],
            |row| row.get(0),
        )
        .expect("read unchanged attention state");
    assert_eq!(attention, before_attention);
}

#[test]
fn expired_begin_send_commits_refund_and_wait_release_before_returning_error() {
    let mut fixture = Fixture::new();
    let input = prepare_input(
        &fixture,
        "request-expired-before-send",
        endpoint("%5", 105),
        true,
        NOW_MS + 1,
        Originator::Unknown,
        true,
    );
    let prepared = {
        let mut requests = service(&mut fixture);
        requests
            .prepare(input, "attempt-expired-before-send".into(), 7)
            .expect("prepare expired request")
    };
    fixture.set_now(NOW_MS + 3_600_001);
    let result = {
        let mut requests = service(&mut fixture);
        requests.begin_send(&prepared.attempt_id)
    };
    assert!(matches!(result, Err(RequestError::Expired)));
    let attempt = {
        let mut requests = service(&mut fixture);
        requests
            .get_attempt(&prepared.attempt_id)
            .expect("read expired attempt")
            .expect("expired metadata retained")
    };
    assert_eq!(attempt.status, AttemptStatus::DefinitelyFailed);
    assert!(!attempt.wait_active);
    assert!(!attempt.cadence_reserved);
    assert_eq!(preamble_count(&fixture.database, &fixture.identity_id), 0);
}

#[test]
fn cleanup_transitions_expired_prepared_rows_in_bounded_batches_and_refunds() {
    let mut fixture = Fixture::new();
    let inputs = (0..101)
        .map(|index| {
            prepare_input(
                &fixture,
                &format!("request-expired-batch-{index:03}"),
                endpoint(&format!("%{}", index + 50), index + 150),
                true,
                NOW_MS + 1,
                Originator::Unknown,
                true,
            )
        })
        .collect::<Vec<_>>();
    {
        let mut requests = service(&mut fixture);
        for (index, input) in inputs.into_iter().enumerate() {
            requests
                .prepare(input, format!("attempt-expired-batch-{index:03}"), 7)
                .expect("prepare expired batch row");
        }
    }
    assert_eq!(preamble_count(&fixture.database, &fixture.identity_id), 101);
    fixture.set_now(NOW_MS + 3_600_001);
    {
        let mut requests = service(&mut fixture);
        requests.cleanup().expect("first expired transition batch");
    }
    let connection = rusqlite::Connection::open(&fixture.database).expect("open transition oracle");
    let prepared: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM request_attempts WHERE status = 'prepared'",
            [],
            |row| row.get(0),
        )
        .expect("count remaining prepared rows");
    let failed: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM request_attempts WHERE status = 'definitely_failed'",
            [],
            |row| row.get(0),
        )
        .expect("count failed rows");
    let first_remaining: String = connection
        .query_row(
            "SELECT attempt_id FROM request_attempts WHERE status = 'prepared' ORDER BY expires_at_ms, attempt_id",
            [],
            |row| row.get(0),
        )
        .expect("read first remaining prepared row");
    assert_eq!(prepared, 1);
    assert_eq!(failed, 100);
    assert_eq!(first_remaining, "attempt-expired-batch-100");
    assert_eq!(preamble_count(&fixture.database, &fixture.identity_id), 1);

    {
        let mut requests = service(&mut fixture);
        requests.cleanup().expect("second expired transition batch");
    }
    assert_eq!(count_rows(&fixture.database, "request_attempts"), 101);
    assert_eq!(preamble_count(&fixture.database, &fixture.identity_id), 0);
    let connection =
        rusqlite::Connection::open(&fixture.database).expect("reopen transition oracle");
    let failed: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM request_attempts WHERE status = 'definitely_failed'",
            [],
            |row| row.get(0),
        )
        .expect("count all failed rows");
    assert_eq!(failed, 101);
}
