use super::*;
use crate::output::identity_document;
use serde_json::{Value, json};
use std::io::Write;
use tmt_core::request::{
    RequestPrompt,
    attention::{Exchange, FinalState},
};

fn final_document<T>(state: &FinalState<T>, content: impl FnOnce(&T) -> Option<Value>) -> Value {
    match state {
        FinalState::NotSubmitted => json!({"status": "not_submitted"}),
        FinalState::Expired {
            submitted_at_ms,
            expires_at_ms,
        } => {
            json!({"status": "expired", "submittedAtMs": submitted_at_ms, "expiresAtMs": expires_at_ms})
        }
        FinalState::Unavailable {
            submitted_at_ms,
            expires_at_ms,
        } => {
            json!({"status": "unavailable", "submittedAtMs": submitted_at_ms, "expiresAtMs": expires_at_ms})
        }
        FinalState::Retained {
            content: body,
            submitted_at_ms,
            body_bytes,
            expires_at_ms,
        } => {
            let mut value = json!({"status": "retained", "submittedAtMs": submitted_at_ms, "bodyBytes": body_bytes, "expiresAtMs": expires_at_ms});
            if let Some(body) = content(body) {
                value["response"] = body;
            }
            value
        }
    }
}

fn prompt_status(prompt: &RequestPrompt) -> &'static str {
    match prompt {
        RequestPrompt::Unavailable => "unavailable",
        RequestPrompt::Expired { .. } => "expired",
        RequestPrompt::Retained(_) => "retained",
    }
}

fn exchange_document<T>(
    exchange: &Exchange<T>,
    content: impl FnOnce(&T) -> Option<Value>,
) -> Value {
    json!({
        "requestId": exchange.request_id,
        "recipientIdentityId": exchange.recipient_identity_id,
        "preparedAtMs": exchange.prepared_at_ms,
        "delivery": exchange.delivery.as_str(),
        "final": final_document(&exchange.final_state, content),
        "revision": exchange.revision,
        "acknowledged": exchange.acknowledged,
        "settled": exchange.settled,
        "retentionExpiresAtMs": exchange.retention_expires_at_ms,
    })
}

fn prompt_document(prompt: &RequestPrompt) -> Value {
    match prompt {
        RequestPrompt::Unavailable => json!({"status": "unavailable"}),
        RequestPrompt::Expired { expires_at_ms } => {
            json!({"status": "expired", "expiresAtMs": expires_at_ms})
        }
        RequestPrompt::Retained(prompt) => {
            json!({"status": "retained", "message": prompt.message, "messageBytes": prompt.message_bytes, "expiresAtMs": prompt.expires_at_ms})
        }
    }
}

fn document(report: &Report) -> Value {
    let mut value = json!({"identity": identity_document(&report.identity)});
    match &report.result {
        ResultKind::List(page) => {
            value["items"] = page
                .items
                .iter()
                .map(|item| exchange_document(item, |_| None))
                .collect();
            value["nextAfter"] = json!(page.next_after);
        }
        ResultKind::Show(detail) => {
            let mut exchange = exchange_document(&detail.exchange, |body| Some(json!(body)));
            exchange["prompt"] = prompt_document(&detail.prompt);
            value["exchange"] = exchange;
        }
        ResultKind::Ack(ack) => {
            value["requestId"] = json!(ack.request_id);
            value["revision"] = json!(ack.revision);
            value["acknowledged"] = json!(true);
            value["changed"] = json!(ack.changed);
        }
        ResultKind::Ackall(through) => value["acknowledgedThrough"] = json!(through),
    }
    value
}

pub(super) fn publish(report: Report, mode: OutputMode) -> io::Result<u8> {
    let mut stdout = io::stdout().lock();
    if mode.json {
        writeln!(stdout, "{}", document(&report))?;
    } else {
        match &report.result {
            ResultKind::List(page) => {
                if page.items.is_empty() {
                    writeln!(stdout, "No unacknowledged exchanges.")?;
                } else {
                    writeln!(stdout, "REQUEST\tRECIPIENT\tDELIVERY\tFINAL\tREVISION")?;
                    for item in &page.items {
                        writeln!(
                            stdout,
                            "{}\t{}\t{}\t{}\t{}",
                            item.request_id,
                            item.recipient_identity_id.as_deref().unwrap_or("-"),
                            item.delivery.as_str(),
                            item.final_state.as_str(),
                            item.revision
                        )?;
                    }
                }
                if let Some(after) = page.next_after {
                    writeln!(
                        stdout,
                        "More exchanges: repeat x list with the same identity and --after {after}."
                    )?;
                }
            }
            ResultKind::Show(detail) => {
                let item = &detail.exchange;
                writeln!(
                    stdout,
                    "REQUEST\tDELIVERY\tFINAL\tREVISION\tACKNOWLEDGED\tSETTLED"
                )?;
                writeln!(
                    stdout,
                    "{}\t{}\t{}\t{}\t{}\t{}",
                    item.request_id,
                    item.delivery.as_str(),
                    item.final_state.as_str(),
                    item.revision,
                    item.acknowledged,
                    item.settled
                )?;
                writeln!(stdout, "Prompt ({}):", prompt_status(&detail.prompt))?;
                if let RequestPrompt::Retained(prompt) = &detail.prompt {
                    writeln!(stdout, "{}", prompt.message)?;
                }
                if let FinalState::Retained { content, .. } = &item.final_state {
                    writeln!(stdout, "Final:\n{content}")?;
                }
            }
            ResultKind::Ack(ack) => writeln!(
                stdout,
                "Acknowledged {} at revision {}{}",
                ack.request_id,
                ack.revision,
                if ack.changed {
                    "."
                } else {
                    " (already acknowledged)."
                }
            )?,
            ResultKind::Ackall(through) => writeln!(
                stdout,
                "Acknowledged identity '{}' through revision {through}. Later revisions remain unacknowledged.",
                report.identity.name
            )?,
        }
    }
    Ok(0)
}
