use super::support::{DAY_MS, Fixture, NOW_MS, count_rows, endpoint, prepare_input, service};
use crate::storage::Storage;
use tmt_core::request::{
    Originator, PreambleReservation, PrepareRequest, RequestError, RequestKind, RequestPrompt,
    RequestRoute, ResponseProof, ResponseRejection, SubmitResponse,
    attention::{FinalState, IncomingKind},
    correlation::response_token,
};

fn input(fixture: &Fixture) -> PrepareRequest {
    let mut input = prepare_input(
        fixture,
        "notice",
        endpoint("%1", 101),
        false,
        NOW_MS + 3_600_000,
        Originator::Unknown,
        false,
    );
    input.kind = RequestKind::Announcement;
    input.route = RequestRoute::Inbox {
        recipient_identity_id: fixture.identity_id.clone(),
    };
    input.message = "  Release notes\nKeep exact text!".into();
    input
}

#[test]
fn announcement_survives_reopen_and_settles_only_after_explicit_ack() {
    let mut fixture = Fixture::new();
    let prepared = input(&fixture);
    let message = prepared.message.clone();
    service(&mut fixture)
        .enqueue(prepared, "notice-attempt".into(), 7)
        .unwrap();
    let path = fixture.database.clone();
    fixture.storage.close().unwrap();
    fixture.storage = Storage::open(path).unwrap();
    let identity = fixture.identity_id.clone();
    let mut requests = service(&mut fixture);
    let page = requests.list_incoming(&identity, None, None, None).unwrap();
    assert_eq!(page.items.len(), 1);
    let item = &page.items[0];
    assert_eq!(item.kind, IncomingKind::Announcement);
    assert_eq!(item.exchange.final_state, FinalState::NotRequired);
    assert!(!item.exchange.settled);
    let detail = requests.show_incoming_request(&identity, "notice").unwrap();
    assert!(matches!(detail.prompt, RequestPrompt::Retained(prompt) if prompt.message == message));
    assert!(
        !detail.exchange.acknowledged,
        "show must not acknowledge a notification"
    );
    requests
        .acknowledge_incoming_request(&identity, "notice", item.exchange.revision)
        .unwrap();
    assert!(
        requests
            .list_incoming(&identity, None, None, None)
            .unwrap()
            .items
            .is_empty()
    );
    let detail = requests.show_incoming_request(&identity, "notice").unwrap();
    assert!(detail.exchange.settled);
    assert_eq!(detail.exchange.final_state, FinalState::NotRequired);
    assert!(
        !requests
            .acknowledge_incoming_request(&identity, "notice", item.exchange.revision)
            .unwrap()
            .changed
    );
    drop(requests);
    assert_eq!(count_rows(&fixture.database, "request_responses"), 0);
}

#[test]
fn announcements_reject_even_correct_reply_proof_without_mutating_attention() {
    let mut fixture = Fixture::new();
    let prepared = input(&fixture);
    let proof = ResponseProof::Compact(response_token("notice", "notice-attempt", &prepared.route));
    service(&mut fixture)
        .enqueue(prepared, "notice-attempt".into(), 7)
        .unwrap();
    let identity = fixture.identity_id.clone();
    let before = service(&mut fixture)
        .list_incoming(&identity, None, None, None)
        .unwrap();
    for _ in 0..2 {
        assert!(matches!(
            service(&mut fixture).submit_response(SubmitResponse {
                request_id: "notice".into(),
                proof: proof.clone(),
                body: "unexpected reply".into(),
            }),
            Err(RequestError::Response(ResponseRejection::NotRequired))
        ));
    }
    assert_eq!(
        service(&mut fixture).get_response("notice").unwrap(),
        tmt_core::request::ResponseLookup::NotRequired
    );
    assert_eq!(
        service(&mut fixture)
            .list_incoming(&identity, None, None, None)
            .unwrap(),
        before
    );
    assert_eq!(count_rows(&fixture.database, "request_responses"), 0);
    assert!(
        !service(&mut fixture)
            .get_attempt("notice-attempt")
            .unwrap()
            .unwrap()
            .wait_active
    );
}

#[test]
fn invalid_announcement_routes_waits_and_preambles_write_nothing() {
    let mut fixture = Fixture::new();
    for variant in 0..3 {
        let mut prepared = input(&fixture);
        match variant {
            0 => prepared.wait = true,
            1 => prepared.route = RequestRoute::Pane(endpoint("%1", 101)),
            _ => {
                prepared.preamble = Some(PreambleReservation {
                    identity_id: fixture.identity_id.clone(),
                    every: 1,
                })
            }
        }
        assert!(matches!(
            service(&mut fixture).prepare(prepared, "notice-attempt".into(), 7),
            Err(RequestError::Invalid(_))
        ));
    }
    assert_eq!(count_rows(&fixture.database, "request_attempts"), 0);
    assert_eq!(
        count_rows(&fixture.database, "request_attention_identities"),
        0
    );
    assert_eq!(count_rows(&fixture.database, "preamble_counters"), 0);
}

#[test]
fn announcement_prompt_expiry_and_ackall_use_existing_retention_and_attention() {
    let mut fixture = Fixture::new();
    let prepared = input(&fixture);
    service(&mut fixture)
        .enqueue(prepared, "notice-attempt".into(), 1)
        .unwrap();
    let identity = fixture.identity_id.clone();
    fixture.set_now(NOW_MS + DAY_MS);
    assert_eq!(
        service(&mut fixture).get_response("notice").unwrap(),
        tmt_core::request::ResponseLookup::NotRequired
    );
    // A normal not-required lookup commits housekeeping; it is not a rejected write.
    let oracle = rusqlite::Connection::open_with_flags(
        &fixture.database,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(
        oracle
            .query_row("SELECT message_text FROM request_attempts", [], |row| {
                row.get::<_, Option<String>>(0)
            })
            .unwrap(),
        None
    );
    let detail = service(&mut fixture)
        .show_incoming_request(&identity, "notice")
        .unwrap();
    assert!(matches!(detail.prompt, RequestPrompt::Expired { .. }));
    assert_eq!(detail.exchange.final_state, FinalState::NotRequired);
    service(&mut fixture)
        .acknowledge_all_incoming_requests(&identity)
        .unwrap();
    assert!(
        service(&mut fixture)
            .show_incoming_request(&identity, "notice")
            .unwrap()
            .exchange
            .settled
    );
    fixture.set_now(NOW_MS + 8 * DAY_MS);
    assert!(
        service(&mut fixture)
            .get_context("notice")
            .unwrap()
            .is_none()
    );
    assert_eq!(count_rows(&fixture.database, "request_attempts"), 0);
}
