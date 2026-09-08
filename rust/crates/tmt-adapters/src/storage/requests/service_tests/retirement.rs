use super::support::{Fixture, NOW_MS, endpoint, prepare_input, service};
use rusqlite::OptionalExtension;
use tmt_core::identity::{Lifetime, create_or_resolve};
use tmt_core::request::{Originator, SubmitResponse};

#[test]
fn late_final_uses_original_provenance_after_identity_retirement_and_name_reuse() {
    let mut fixture = Fixture::new();
    let original_id = fixture.identity_id.clone();
    let target = endpoint("%40", 140);
    let input = prepare_input(
        &fixture,
        "request-retired-identity-final",
        target.clone(),
        false,
        NOW_MS + 3_600_001,
        Originator::Explicit(original_id.clone()),
        false,
    );
    let prepared = {
        let mut requests = service(&mut fixture);
        requests
            .prepare(input, "attempt-retired-identity-final".into(), 1)
            .expect("prepare retired-identity request")
    };
    {
        let mut requests = service(&mut fixture);
        requests
            .begin_send(&prepared.attempt_id)
            .expect("begin retired-identity request");
    }

    let connection = rusqlite::Connection::open(&fixture.database).expect("open identity oracle");
    connection
        .execute(
            "UPDATE identities SET retired_at_ms = ? WHERE id = ?",
            rusqlite::params![NOW_MS as i64, original_id],
        )
        .expect("retire original identity");
    drop(connection);
    let replacement = create_or_resolve(&mut fixture.storage, "Request Owner", Lifetime::Saved)
        .expect("reuse retired identity name")
        .identity;
    assert_ne!(replacement.id, fixture.identity_id);

    // The original attempt is accepted after its send deadline even though the
    // active identity now resolves to a different UUID. Direct SQL retirement
    // is setup here; binding/removal policy has its own adapter tests.
    fixture.set_now(NOW_MS + 3_600_002);
    {
        let mut requests = service(&mut fixture);
        let final_response = requests
            .submit_response(SubmitResponse {
                request_id: prepared.request_id.clone(),
                attempt_id: prepared.attempt_id.clone(),
                endpoint: target,
                body: "late final after retirement".into(),
            })
            .expect("accept late final for retired identity");
        assert_eq!(final_response.body, "late final after retirement");
    }

    let connection = rusqlite::Connection::open(&fixture.database).expect("reopen identity oracle");
    let provenance: (Option<String>, String, Option<String>) = connection
        .query_row(
            "SELECT identity_id, originator_identity_id, recipient_identity_id FROM request_attempts WHERE request_id = ?",
            [&prepared.request_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("read historical provenance");
    assert_eq!(
        provenance,
        (None, original_id.clone(), Some(original_id.clone()))
    );
    let final_body: String = connection
        .query_row(
            "SELECT body FROM request_responses WHERE request_id = ?",
            [&prepared.request_id],
            |row| row.get(0),
        )
        .expect("read late final");
    assert_eq!(final_body, "late final after retirement");
    let identities: Vec<(String, Option<i64>)> = connection
        .prepare("SELECT id, retired_at_ms FROM identities WHERE canonical_name = ? ORDER BY id")
        .expect("prepare identity rows")
        .query_map([replacement.canonical_name.as_str()], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .expect("query identity rows")
        .collect::<rusqlite::Result<_>>()
        .expect("decode identity rows");
    assert_eq!(identities.len(), 2);
    assert!(
        identities
            .iter()
            .any(|(id, retired)| id == &original_id && retired.is_some())
    );
    assert!(
        identities
            .iter()
            .any(|(id, retired)| id == &replacement.id && retired.is_none())
    );
    let replacement_attention: Option<i64> = connection
        .query_row(
            "SELECT latest_revision FROM request_attention_identities WHERE identity_id = ?",
            [&replacement.id],
            |row| row.get(0),
        )
        .optional()
        .expect("read replacement attention state");
    assert_eq!(replacement_attention, None);
    drop(connection);
    let response = {
        let mut requests = service(&mut fixture);
        requests
            .get_response(&prepared.request_id)
            .expect("read late final through a fresh service")
            .expect("late final remains retained")
    };
    assert_eq!(response.body, "late final after retirement");
}
