use super::*;
use crate::request::attention::{
    Acknowledged, AttentionRecord, AttentionRejection, DEFAULT_LIST_LIMIT, Exchange,
    ExchangeDetail, ExchangePage, FinalState, MAX_LIST_LIMIT,
};

fn selector<E>(value: &str) -> Result<(), RequestError<E>> {
    if value.is_empty() {
        Err(RequestError::Attention(AttentionRejection::Invalid(
            "Identifiers must be non-empty.",
        )))
    } else {
        Ok(())
    }
}

fn missing<E>() -> RequestError<E> {
    RequestError::Attention(AttentionRejection::NotFound)
}

fn retained<E>(
    records: &mut dyn RequestRecords<Error = E>,
    identity: &str,
    request: &str,
    now: u64,
) -> Result<AttentionRecord, RequestError<E>> {
    records
        .find_attention(identity, request)?
        .filter(|record| now < record.attempt.retention_expires_at_ms)
        .ok_or_else(missing)
}

fn final_state<T, E>(
    record: &AttentionRecord,
    now: u64,
    content: Option<T>,
) -> Result<FinalState<T>, RequestError<E>> {
    let Some(submitted_at_ms) = record.attempt.response_submitted_at_ms else {
        return Ok(FinalState::NotSubmitted);
    };
    let expires_at_ms = match &record.response_metadata {
        Some(metadata) => metadata.expires_at_ms,
        None => retention_deadline(submitted_at_ms, record.attempt.retention_days)
            .ok_or(RequestError::Invalid("Invalid retained final horizon."))?,
    };
    if now >= expires_at_ms {
        return Ok(FinalState::Expired {
            submitted_at_ms,
            expires_at_ms,
        });
    }
    Ok(match (&record.response_metadata, content) {
        (Some(metadata), Some(content)) => FinalState::Retained {
            content,
            submitted_at_ms,
            body_bytes: metadata.body_bytes,
            expires_at_ms,
        },
        _ => FinalState::Unavailable {
            submitted_at_ms,
            expires_at_ms,
        },
    })
}

fn exchange<T>(record: AttentionRecord, final_state: FinalState<T>) -> Exchange<T> {
    let acknowledged = record.acknowledged_revision >= record.revision
        || record.acknowledged_through >= record.revision;
    Exchange {
        request_id: record.attempt.request_id,
        recipient_identity_id: record.attempt.recipient_identity_id,
        prepared_at_ms: record.attempt.prepared_at_ms,
        delivery: record.attempt.status,
        final_state,
        revision: record.revision,
        acknowledged,
        settled: acknowledged && record.attempt.response_submitted_at_ms.is_some(),
        retention_expires_at_ms: record.attempt.retention_expires_at_ms,
    }
}

impl<R: RequestRepository, C: Fn() -> u64> RequestService<'_, R, C> {
    pub fn list_exchanges(
        &mut self,
        identity: &str,
        limit: Option<u64>,
        after: Option<u64>,
    ) -> Result<ExchangePage, RequestError<R::Error>> {
        selector(identity)?;
        let limit = limit.unwrap_or(DEFAULT_LIST_LIMIT);
        let after = after.unwrap_or(0);
        if limit == 0 || limit > MAX_LIST_LIMIT || after > MAX_JS_SAFE_INTEGER {
            return Err(RequestError::Attention(AttentionRejection::Invalid(
                "Invalid exchange list limit or cursor.",
            )));
        }
        self.read(|records, now| {
            let mut rows = records.list_attention(identity, after, limit + 1, now)?;
            let more = rows.len() as u64 > limit;
            rows.truncate(limit as usize);
            let next_after = more.then(|| rows.last().expect("nonzero limit").revision);
            let items = rows
                .into_iter()
                .map(|record| {
                    let state = final_state(&record, now, Some(()))?;
                    Ok(exchange(record, state))
                })
                .collect::<Result<_, RequestError<R::Error>>>()?;
            Ok(ExchangePage { items, next_after })
        })
    }

    pub fn show_exchange(
        &mut self,
        identity: &str,
        request: &str,
    ) -> Result<ExchangeDetail, RequestError<R::Error>> {
        selector(identity)?;
        selector(request)?;
        self.read(|records, now| {
            let record = retained(records, identity, request, now)?;
            let context = context(records, request, now)?.ok_or_else(missing)?;
            let response = records
                .find_response(request)?
                .filter(|response| now < response.response_expires_at_ms);
            let state = final_state(&record, now, response.map(|response| response.body))?;
            Ok(ExchangeDetail {
                exchange: exchange(record, state),
                prompt: context.prompt,
            })
        })
    }

    pub fn acknowledge_exchange(
        &mut self,
        identity: &str,
        request: &str,
        revision: u64,
    ) -> Result<Acknowledged, RequestError<R::Error>> {
        selector(identity)?;
        selector(request)?;
        if revision == 0 || revision > MAX_JS_SAFE_INTEGER {
            return Err(RequestError::Attention(AttentionRejection::Invalid(
                "Revision must be a positive safe integer.",
            )));
        }
        self.read(|records, now| {
            let record = retained(records, identity, request, now)?;
            if record.revision != revision {
                return Err(RequestError::Attention(
                    AttentionRejection::RevisionConflict {
                        current: record.revision,
                        expected: revision,
                    },
                ));
            }
            let changed =
                record.acknowledged_revision < revision && record.acknowledged_through < revision;
            if changed && !records.acknowledge_revision(identity, request, revision)? {
                return Err(RequestError::StateInvalid);
            }
            Ok(Acknowledged {
                request_id: request.into(),
                revision,
                changed,
            })
        })
    }

    pub fn acknowledge_all_exchanges(
        &mut self,
        identity: &str,
    ) -> Result<u64, RequestError<R::Error>> {
        selector(identity)?;
        self.read(|records, _| {
            let Some(latest) = records.attention_counter(identity)? else {
                return Ok(0);
            };
            if !records.acknowledge_through(identity, latest)? {
                return Err(RequestError::StateInvalid);
            }
            Ok(latest)
        })
    }
}
