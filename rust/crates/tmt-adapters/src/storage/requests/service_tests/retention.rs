use super::support::{DAY_MS, Fixture, NOW_MS, count_rows, endpoint, prepare_input, service};
use tmt_core::request::{Originator, RequestError, RequestPrompt, Settlement, SubmitResponse};

#[test]
fn cleanup_failure_rolls_back_earlier_prompt_scrubbing() {
    let mut fixture = Fixture::new();
    let target = endpoint("%70", 170);
    let input = prepare_input(
        &fixture,
        "cleanup-rollback",
        target.clone(),
        false,
        NOW_MS + 1,
        Originator::Unknown,
        false,
    );
    let original_message = input.message.clone();
    {
        let mut requests = service(&mut fixture);
        requests
            .prepare(input, "cleanup-rollback-attempt".into(), 1)
            .unwrap();
        requests.begin_send("cleanup-rollback-attempt").unwrap();
        requests
            .settle("cleanup-rollback-attempt", Settlement::Sent)
            .unwrap();
        requests
            .submit_response(SubmitResponse {
                request_id: "cleanup-rollback".into(),
                attempt_id: "cleanup-rollback-attempt".into(),
                endpoint: target,
                body: "final".into(),
            })
            .unwrap();
    }
    // Fail the phase after prompt scrubbing, without replacing production SQL.
    let oracle = rusqlite::Connection::open(&fixture.database).unwrap();
    oracle
        .execute_batch(
            "CREATE TRIGGER reject_final_cleanup BEFORE DELETE ON request_responses
         BEGIN SELECT RAISE(ABORT, 'injected cleanup failure'); END;",
        )
        .unwrap();
    fixture.set_now(NOW_MS + DAY_MS);
    assert!(matches!(
        service(&mut fixture).cleanup(),
        Err(RequestError::Repository(_))
    ));
    let prompt: (String, i64) = oracle.query_row(
        "SELECT message_text, message_bytes FROM request_attempts WHERE request_id = 'cleanup-rollback'",
        [], |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    assert_eq!(
        prompt,
        (original_message.clone(), original_message.len() as i64)
    );
    assert_eq!(count_rows(&fixture.database, "request_responses"), 1);

    oracle
        .execute_batch("DROP TRIGGER reject_final_cleanup")
        .unwrap();
    service(&mut fixture).cleanup().unwrap();
    let prompt: Option<String> = oracle
        .query_row(
            "SELECT message_text FROM request_attempts WHERE request_id = 'cleanup-rollback'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(prompt, None);
    assert_eq!(count_rows(&fixture.database, "request_responses"), 0);
}

#[test]
fn cleanup_scrubs_prompt_and_final_body_at_equality_before_metadata() {
    let mut fixture = Fixture::new();
    let target = endpoint("%20", 120);
    let input = prepare_input(
        &fixture,
        "request-retention-boundary",
        target.clone(),
        true,
        NOW_MS + 3_600_001,
        Originator::Unknown,
        false,
    );
    let prepared = {
        let mut requests = service(&mut fixture);
        requests
            .prepare(input, "attempt-retention-boundary".into(), 1)
            .expect("prepare retention request")
    };
    {
        let mut requests = service(&mut fixture);
        requests
            .begin_send(&prepared.attempt_id)
            .expect("begin retention request");
        requests
            .settle(&prepared.attempt_id, Settlement::Sent)
            .expect("settle retention request");
        requests
            .submit_response(SubmitResponse {
                request_id: prepared.request_id.clone(),
                attempt_id: prepared.attempt_id.clone(),
                endpoint: target,
                body: "retained final".into(),
            })
            .expect("submit retention final");
        requests
            .release_wait(&prepared.attempt_id)
            .expect("release retention waiter");
    }
    let before = {
        let connection = rusqlite::Connection::open(&fixture.database).expect("open SQL oracle");
        connection
            .query_row(
                "SELECT retention_expires_at_ms, message_expires_at_ms FROM request_attempts WHERE attempt_id = ?",
                [&prepared.attempt_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .expect("read retention deadlines")
    };
    fixture.set_now(NOW_MS + DAY_MS);
    {
        let mut requests = service(&mut fixture);
        requests.cleanup().expect("cleanup expired bodies");
        assert!(
            requests
                .get_response(&prepared.request_id)
                .expect("read final")
                .is_none()
        );
        let context = requests
            .get_context(&prepared.request_id)
            .expect("read scrubbed context")
            .expect("metadata remains retained");
        assert!(matches!(context.prompt, RequestPrompt::Expired { .. }));
    }
    // Scrubbing is durable state, not a function of the current wall clock:
    // rolling the injected clock back must still decode the marker as Expired.
    fixture.set_now(NOW_MS);
    {
        let mut requests = service(&mut fixture);
        let context = requests
            .get_context(&prepared.request_id)
            .expect("read scrubbed context after clock rollback")
            .expect("metadata remains retained after clock rollback");
        assert!(matches!(context.prompt, RequestPrompt::Expired { .. }));
    }
    let connection = rusqlite::Connection::open(&fixture.database).expect("reopen SQL oracle");
    let row: (Option<String>, Option<i64>, Option<i64>, Option<i64>) = connection
        .query_row(
            "SELECT message_text, message_bytes, message_expires_at_ms, response_submitted_at_ms FROM request_attempts WHERE attempt_id = ?",
            [&prepared.attempt_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("read scrubbed markers");
    assert_eq!(row.0, None);
    assert_eq!(row.1, None);
    assert_eq!(row.2, Some(before.1));
    assert!(row.3.is_some());
    assert_eq!(count_rows(&fixture.database, "request_responses"), 0);

    fixture.set_now(before.0 as u64);
    {
        let mut requests = service(&mut fixture);
        requests.cleanup().expect("cleanup expired metadata");
    }
    assert_eq!(count_rows(&fixture.database, "request_attempts"), 0);
}

#[test]
fn cleanup_drains_each_phase_in_deterministic_batches_of_one_hundred() {
    let mut fixture = Fixture::new();
    let inputs = (0..101)
        .map(|index| {
            let request_id = format!("request-batch-{index:03}");
            prepare_input(
                &fixture,
                &request_id,
                endpoint(&format!("%{}", index + 30), (index + 130) as u64),
                true,
                NOW_MS + 3_600_001,
                Originator::Unknown,
                false,
            )
        })
        .collect::<Vec<_>>();
    {
        let mut requests = service(&mut fixture);
        for (index, input) in inputs.into_iter().enumerate() {
            let prepared = requests
                .prepare(input, format!("attempt-batch-{index:03}"), 1)
                .expect("prepare batch request");
            requests
                .begin_send(&prepared.attempt_id)
                .expect("begin batch request");
            requests
                .settle(&prepared.attempt_id, Settlement::Sent)
                .expect("settle batch request");
            requests
                .submit_response(SubmitResponse {
                    request_id: prepared.request_id,
                    attempt_id: prepared.attempt_id,
                    endpoint: endpoint(&format!("%{}", index + 30), (index + 130) as u64),
                    body: format!("body-{index:03}"),
                })
                .expect("submit batch final");
            requests
                .release_wait(&format!("attempt-batch-{index:03}"))
                .expect("release batch waiter");
        }
    }

    fixture.set_now(NOW_MS + DAY_MS);
    {
        let mut requests = service(&mut fixture);
        requests.cleanup().expect("first bounded cleanup");
    }
    let connection = rusqlite::Connection::open(&fixture.database).expect("open batch SQL oracle");
    let remaining_responses: i64 = connection
        .query_row("SELECT COUNT(*) FROM request_responses", [], |row| {
            row.get(0)
        })
        .expect("count first response batch");
    let remaining_prompts: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM request_attempts WHERE message_text IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .expect("count first prompt batch");
    let remaining_response_request: String = connection
        .query_row(
            "SELECT request_id FROM request_responses ORDER BY request_id",
            [],
            |row| row.get(0),
        )
        .expect("read first remaining response");
    let remaining_prompt_attempt: String = connection
        .query_row(
            "SELECT attempt_id FROM request_attempts WHERE message_text IS NOT NULL ORDER BY attempt_id",
            [],
            |row| row.get(0),
        )
        .expect("read first remaining prompt");
    assert_eq!(remaining_responses, 1);
    assert_eq!(remaining_prompts, 1);
    assert_eq!(remaining_response_request, "request-batch-100");
    assert_eq!(remaining_prompt_attempt, "attempt-batch-100");

    {
        let mut requests = service(&mut fixture);
        requests.cleanup().expect("second bounded cleanup");
    }
    let connection = rusqlite::Connection::open(&fixture.database).expect("reopen batch oracle");
    let remaining_responses: i64 = connection
        .query_row("SELECT COUNT(*) FROM request_responses", [], |row| {
            row.get(0)
        })
        .expect("count drained responses");
    let remaining_prompts: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM request_attempts WHERE message_text IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .expect("count drained prompts");
    assert_eq!(remaining_responses, 0);
    assert_eq!(remaining_prompts, 0);
    assert_eq!(count_rows(&fixture.database, "request_attempts"), 101);

    fixture.set_now(NOW_MS + 7 * DAY_MS);
    {
        let mut requests = service(&mut fixture);
        requests.cleanup().expect("first metadata batch");
    }
    assert_eq!(count_rows(&fixture.database, "request_attempts"), 1);
    {
        let mut requests = service(&mut fixture);
        requests.cleanup().expect("second metadata batch");
    }
    assert_eq!(count_rows(&fixture.database, "request_attempts"), 0);
}
