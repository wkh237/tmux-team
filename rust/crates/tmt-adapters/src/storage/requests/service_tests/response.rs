use super::support::{
    Fixture, NOW_MS, count_rows, endpoint, preamble_count, prepare_input, service,
};
use tmt_core::limits::MAX_JS_SAFE_INTEGER;
use tmt_core::request::{
    AttemptStatus, Originator, PrepareRequest, RequestError, ResponseRejection, Settlement,
    SubmitResponse,
};

fn prepare_sending(
    fixture: &mut Fixture,
    request_id: &str,
) -> (String, tmt_core::request::RequestEndpoint) {
    let target = endpoint("%10", 110);
    let input = prepare_input(
        fixture,
        request_id,
        target.clone(),
        true,
        NOW_MS + 3_600_001,
        Originator::Unknown,
        false,
    );
    let prepared = {
        let mut requests = service(fixture);
        requests
            .prepare(input, format!("attempt-{request_id}"), 7)
            .expect("prepare response request")
    };
    {
        let mut requests = service(fixture);
        requests
            .begin_send(&prepared.attempt_id)
            .expect("begin response request");
    }
    (prepared.attempt_id, target)
}

fn submit(
    fixture: &mut Fixture,
    request_id: &str,
    attempt_id: &str,
    target: tmt_core::request::RequestEndpoint,
    body: &str,
) -> Result<tmt_core::request::FinalResponse, RequestError<crate::storage::StorageError>> {
    let mut requests = service(fixture);
    requests.submit_response(SubmitResponse {
        request_id: request_id.into(),
        attempt_id: attempt_id.into(),
        endpoint: target,
        body: body.into(),
    })
}

#[test]
fn final_body_is_exact_and_identical_retry_is_immutable() {
    let mut fixture = Fixture::new();
    let (attempt_id, target) = prepare_sending(&mut fixture, "request-exact-final");
    let body = "\u{feff}  first\r\n\u{0000} 日本語 🙂  ";
    let first = submit(
        &mut fixture,
        "request-exact-final",
        &attempt_id,
        target.clone(),
        body,
    )
    .expect("submit exact final");
    assert_eq!(first.body, body);
    assert_eq!(first.body_bytes, body.len() as u64);
    assert_eq!(count_rows(&fixture.database, "request_responses"), 1);

    // A retry through a fresh service at a later clock value must not renew
    // the immutable final's submission time or expiry.
    fixture.set_now(NOW_MS + 1);
    let retry = submit(
        &mut fixture,
        "request-exact-final",
        &attempt_id,
        target.clone(),
        body,
    )
    .expect("retry identical final");
    assert_eq!(retry, first);
    assert!(matches!(
        submit(
            &mut fixture,
            "request-exact-final",
            &attempt_id,
            target,
            "different final"
        ),
        Err(RequestError::Response(ResponseRejection::Conflict))
    ));
    assert_eq!(count_rows(&fixture.database, "request_responses"), 1);
}

#[test]
fn every_endpoint_fence_mismatch_leaves_final_and_attempt_unchanged() {
    let mut fixture = Fixture::new();
    let (attempt_id, target) = prepare_sending(&mut fixture, "request-endpoint-fence");
    let before = {
        let mut requests = service(&mut fixture);
        requests
            .get_attempt(&attempt_id)
            .expect("read attempt")
            .expect("attempt exists")
    };
    let mismatches = [
        tmt_core::request::RequestEndpoint {
            server: tmt_core::endpoint::ServerEvidence {
                server_id: "other-server".into(),
                ..target.server.clone()
            },
            ..target.clone()
        },
        tmt_core::request::RequestEndpoint {
            server: tmt_core::endpoint::ServerEvidence {
                socket_path: "/tmp/other.sock".into(),
                ..target.server.clone()
            },
            ..target.clone()
        },
        tmt_core::request::RequestEndpoint {
            server: tmt_core::endpoint::ServerEvidence {
                server_pid: target.server.server_pid + 1,
                ..target.server.clone()
            },
            ..target.clone()
        },
        tmt_core::request::RequestEndpoint {
            server: tmt_core::endpoint::ServerEvidence {
                server_start_time: "other-start".into(),
                ..target.server.clone()
            },
            ..target.clone()
        },
        tmt_core::request::RequestEndpoint {
            pane_id: "%11".into(),
            ..target.clone()
        },
        tmt_core::request::RequestEndpoint {
            pane_pid: target.pane_pid + 1,
            ..target.clone()
        },
    ];
    assert!(matches!(
        submit(
            &mut fixture,
            "other-request",
            &attempt_id,
            target.clone(),
            "body"
        ),
        Err(RequestError::Response(ResponseRejection::RequestNotFound))
    ));
    assert!(matches!(
        submit(
            &mut fixture,
            "request-endpoint-fence",
            "other-attempt",
            target.clone(),
            "body"
        ),
        Err(RequestError::Response(ResponseRejection::AttemptMismatch))
    ));
    assert_eq!(count_rows(&fixture.database, "request_responses"), 0);
    for mismatched in mismatches {
        assert!(matches!(
            submit(
                &mut fixture,
                "request-endpoint-fence",
                &attempt_id,
                mismatched,
                "body"
            ),
            Err(RequestError::Response(ResponseRejection::RecipientMismatch))
        ));
        assert_eq!(count_rows(&fixture.database, "request_responses"), 0);
    }
    let after = {
        let mut requests = service(&mut fixture);
        requests
            .get_attempt(&attempt_id)
            .expect("read unchanged attempt")
            .expect("attempt exists")
    };
    assert_eq!(after, before);
}

#[test]
fn first_final_attention_overflow_rolls_back_body_and_completion_marker() {
    let mut fixture = Fixture::new();
    let target = endpoint("%12", 112);
    let input: PrepareRequest = prepare_input(
        &fixture,
        "request-final-attention-overflow",
        target.clone(),
        false,
        NOW_MS + 3_600_001,
        Originator::Explicit(fixture.identity_id.clone()),
        false,
    );
    let prepared = {
        let mut requests = service(&mut fixture);
        requests
            .prepare(input, "attempt-final-attention-overflow".into(), 7)
            .expect("prepare attention request")
    };
    {
        let mut requests = service(&mut fixture);
        requests
            .begin_send(&prepared.attempt_id)
            .expect("begin attention request");
        requests
            .settle(&prepared.attempt_id, Settlement::Sent)
            .expect("settle attention request");
    }
    let connection = rusqlite::Connection::open(&fixture.database).expect("open SQL oracle");
    connection
        .execute(
            "UPDATE request_attention_identities SET latest_revision = ? WHERE identity_id = ?",
            rusqlite::params![MAX_JS_SAFE_INTEGER as i64, fixture.identity_id],
        )
        .expect("exhaust attention revision");
    drop(connection);

    let result = submit(
        &mut fixture,
        &prepared.request_id,
        &prepared.attempt_id,
        target,
        "final before overflow",
    );
    assert!(matches!(result, Err(RequestError::RevisionExhausted)));
    assert_eq!(count_rows(&fixture.database, "request_responses"), 0);
    let connection = rusqlite::Connection::open(&fixture.database).expect("reopen SQL oracle");
    let marker: Option<i64> = connection
        .query_row(
            "SELECT response_submitted_at_ms FROM request_attempts WHERE attempt_id = ?",
            [&prepared.attempt_id],
            |row| row.get(0),
        )
        .expect("read completion marker");
    assert_eq!(marker, None);
    let status: String = connection
        .query_row(
            "SELECT status FROM request_attempts WHERE attempt_id = ?",
            [&prepared.attempt_id],
            |row| row.get(0),
        )
        .expect("read attempt status");
    assert_eq!(status, AttemptStatus::Sent.as_str());
}

#[test]
fn response_first_settlement_does_not_refund_reserved_cadence() {
    let mut fixture = Fixture::new();
    let target = endpoint("%13", 113);
    let input = prepare_input(
        &fixture,
        "request-response-first",
        target.clone(),
        false,
        NOW_MS + 3_600_001,
        Originator::Explicit(fixture.identity_id.clone()),
        true,
    );
    let prepared = {
        let mut requests = service(&mut fixture);
        requests
            .prepare(input, "attempt-response-first".into(), 7)
            .expect("prepare response-first request")
    };
    {
        let mut requests = service(&mut fixture);
        requests
            .begin_send(&prepared.attempt_id)
            .expect("begin response-first request");
        requests
            .submit_response(SubmitResponse {
                request_id: prepared.request_id.clone(),
                attempt_id: prepared.attempt_id.clone(),
                endpoint: target,
                body: "response arrived first".into(),
            })
            .expect("submit response before settlement");
        requests
            .settle(&prepared.attempt_id, Settlement::DefinitelyFailed)
            .expect("settle response-first attempt as uncertain");
        let attempt = requests
            .get_attempt(&prepared.attempt_id)
            .expect("read response-first attempt")
            .expect("response-first attempt remains retained");
        assert_eq!(attempt.status, AttemptStatus::Uncertain);
        assert!(attempt.cadence_reserved);
    }
    assert_eq!(preamble_count(&fixture.database, &fixture.identity_id), 1);
}
