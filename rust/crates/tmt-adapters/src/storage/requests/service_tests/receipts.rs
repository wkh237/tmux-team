use super::support::{DAY_MS, Fixture, NOW_MS, count_rows, endpoint, prepare_input, service};
use crate::{
    reply_receipt::{decode_reply_receipt, encode_short_receipt},
    storage::Storage,
};
use tmt_core::request::{
    Originator, RequestError, ResponseProof, ResponseRejection, SubmitResponse,
};

#[test]
fn compact_rejection_never_cleans_expired_rows_or_changes_attention() {
    let mut fixture = Fixture::new();
    let target = endpoint("%90", 190);
    let input = prepare_input(
        &fixture,
        "compact",
        target.clone(),
        true,
        NOW_MS + 1,
        Originator::Explicit(fixture.identity_id.clone()),
        true,
    );
    service(&mut fixture)
        .prepare(input, "compact-attempt".into(), 1)
        .unwrap();
    service(&mut fixture).begin_send("compact-attempt").unwrap();
    let encoded = encode_short_receipt("compact", "compact-attempt", &target);
    let ResponseProof::Compact(token) = decode_reply_receipt(&encoded, "compact").unwrap() else {
        panic!("compact proof")
    };
    fixture.set_now(NOW_MS + DAY_MS);
    // Every byte participates in the comparison, including the digest suffix.
    for index in 0..16 {
        let mut wrong = token;
        wrong[index] ^= 1;
        assert!(matches!(
            service(&mut fixture).submit_response(SubmitResponse {
                request_id: "compact".into(),
                proof: ResponseProof::Compact(wrong),
                body: "bad".into(),
            }),
            Err(RequestError::Response(ResponseRejection::ReceiptMismatch))
        ));
    }
    assert!(matches!(
        service(&mut fixture).submit_response(SubmitResponse {
            request_id: "unknown".into(),
            proof: ResponseProof::Compact(token),
            body: "bad".into(),
        }),
        Err(RequestError::Response(ResponseRejection::RequestNotFound))
    ));
    assert_eq!(count_rows(&fixture.database, "request_responses"), 0);
    let oracle = rusqlite::Connection::open_with_flags(
        &fixture.database,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    let state: (String, i64, String, Option<i64>, i64, i64) = oracle
        .query_row(
            "SELECT a.status, a.wait_active, a.message_text, a.response_submitted_at_ms,
          c.reserved_count, s.latest_revision FROM request_attempts a
          JOIN preamble_counters c ON c.identity_id = a.identity_id
          JOIN request_attention_identities s ON s.identity_id = a.originator_identity_id",
            [],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        state,
        ("sending".into(), 1, "prompt for compact".into(), None, 1, 1)
    );
    let first = service(&mut fixture)
        .submit_response(SubmitResponse {
            request_id: "compact".into(),
            proof: ResponseProof::Compact(token),
            body: "\u{feff}\0\r\nexact".into(),
        })
        .unwrap();
    assert_eq!(first.body, "\u{feff}\0\r\nexact");
    let revision: i64 = oracle
        .query_row(
            "SELECT latest_revision FROM request_attention_identities",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(revision, 2);
}

#[test]
fn compact_retry_uses_retained_final_after_restart_and_attempt_removal() {
    let mut fixture = Fixture::new();
    let target = endpoint("%91", 191);
    let input = prepare_input(
        &fixture,
        "orphan-token",
        target.clone(),
        false,
        NOW_MS + 1,
        Originator::Unknown,
        false,
    );
    service(&mut fixture)
        .prepare(input, "orphan-token-attempt".into(), 1)
        .unwrap();
    service(&mut fixture)
        .begin_send("orphan-token-attempt")
        .unwrap();
    let encoded = encode_short_receipt("orphan-token", "orphan-token-attempt", &target);
    let input = |body: &str| SubmitResponse {
        request_id: "orphan-token".into(),
        proof: decode_reply_receipt(&encoded, "orphan-token").unwrap(),
        body: body.into(),
    };
    let first = service(&mut fixture)
        .submit_response(input("original"))
        .unwrap();
    fixture.storage.close().unwrap();
    let oracle = rusqlite::Connection::open(&fixture.database).unwrap();
    assert_eq!(
        oracle
            .execute(
                "DELETE FROM request_attempts WHERE request_id = 'orphan-token'",
                []
            )
            .unwrap(),
        1
    );
    fixture.storage = Storage::open(&fixture.database).unwrap();
    fixture.set_now(NOW_MS + 100);
    assert_eq!(
        service(&mut fixture)
            .submit_response(input("original"))
            .unwrap(),
        first
    );
    assert!(matches!(
        service(&mut fixture).submit_response(input("conflict")),
        Err(RequestError::Response(ResponseRejection::Conflict))
    ));
    fixture.set_now(first.response_expires_at_ms);
    assert!(matches!(
        service(&mut fixture).submit_response(input("original")),
        Err(RequestError::Response(ResponseRejection::Expired))
    ));
    let stored: (String, i64, i64) = oracle
        .query_row(
            "SELECT body, submitted_at_ms, response_expires_at_ms FROM request_responses",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        stored,
        ("original".into(), NOW_MS as i64, (NOW_MS + DAY_MS) as i64)
    );
    assert_eq!(count_rows(&fixture.database, "request_attempts"), 0);
}

#[test]
fn compact_proof_is_bound_to_stored_endpoint_not_only_attempt_id() {
    let mut fixture = Fixture::new();
    let target = endpoint("%92", 192);
    let input = prepare_input(
        &fixture,
        "replaced-endpoint",
        target.clone(),
        false,
        NOW_MS + 1,
        Originator::Unknown,
        false,
    );
    service(&mut fixture)
        .prepare(input, "replaced-attempt".into(), 1)
        .unwrap();
    service(&mut fixture)
        .begin_send("replaced-attempt")
        .unwrap();
    let receipt = encode_short_receipt("replaced-endpoint", "replaced-attempt", &target);
    let oracle = rusqlite::Connection::open(&fixture.database).unwrap();
    oracle
        .execute("UPDATE request_attempts SET pane_pid = pane_pid + 1", [])
        .unwrap();
    assert!(matches!(
        service(&mut fixture).submit_response(SubmitResponse {
            request_id: "replaced-endpoint".into(),
            proof: decode_reply_receipt(&receipt, "replaced-endpoint").unwrap(),
            body: "bad".into(),
        }),
        Err(RequestError::Response(ResponseRejection::ReceiptMismatch))
    ));
    assert_eq!(count_rows(&fixture.database, "request_responses"), 0);
    let marker: Option<i64> = oracle
        .query_row(
            "SELECT response_submitted_at_ms FROM request_attempts",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(marker, None);
}
