use super::*;

impl<R: RequestRepository, C: Fn() -> u64> RequestService<'_, R, C> {
    pub fn submit_response(
        &mut self,
        input: SubmitResponse,
    ) -> Result<FinalResponse, RequestError<R::Error>> {
        if input.request_id.is_empty()
            || input.attempt_id.is_empty()
            || endpoint_valid::<R::Error>(&input.endpoint).is_err()
        {
            return Err(RequestError::Response(ResponseRejection::InputInvalid));
        }
        validate_exact_text(input.body.as_bytes())
            .map_err(|_| RequestError::Response(ResponseRejection::InputTooLarge))?;
        let clock = &self.clock;
        self.repository.with_request_transaction(|records| {
            let now = positive(clock())?;
            // No housekeeping on a rejected submission: even unrelated rows
            // must remain unchanged. Retained finals are authoritative for retries.
            if let Some(existing) = records.find_response(&input.request_id)? {
                validate_fence(&existing.attempt_id, &existing.endpoint, &input)?;
                if now >= existing.response_expires_at_ms {
                    return Err(RequestError::Response(ResponseRejection::Expired));
                }
                if input.body != existing.body {
                    return Err(RequestError::Response(ResponseRejection::Conflict));
                }
                return Ok(existing);
            }
            let attempt = records
                .find_request(&input.request_id)?
                .ok_or(RequestError::Response(ResponseRejection::RequestNotFound))?;
            validate_fence(&attempt.attempt_id, &attempt.endpoint, &input)?;
            if attempt.response_submitted_at_ms.is_some()
                || response_deadline_passed(now, attempt.prepared_at_ms, attempt.expires_at_ms)
            {
                return Err(RequestError::Response(ResponseRejection::Expired));
            }
            if !matches!(
                attempt.status,
                AttemptStatus::Sending | AttemptStatus::Sent | AttemptStatus::Uncertain
            ) {
                return Err(RequestError::Response(ResponseRejection::StateInvalid));
            }
            let response = FinalResponse {
                request_id: input.request_id,
                attempt_id: input.attempt_id,
                endpoint: input.endpoint,
                body_bytes: input.body.len() as u64,
                body: input.body,
                submitted_at_ms: now,
                response_expires_at_ms: retention_deadline(now, attempt.retention_days)
                    .ok_or(RequestError::Invalid("Invalid response deadline."))?,
            };
            records.create_response(&response)?;
            if let Some(id) = attempt.originator.identity_id() {
                let revision = reserve_revision(records, id)?;
                records.set_attention_revision(&response.request_id, revision)?;
            }
            Ok(response)
        })
    }

    pub fn get_response(
        &mut self,
        request_id: &str,
    ) -> Result<Option<FinalResponse>, RequestError<R::Error>> {
        if request_id.is_empty() {
            return Err(RequestError::Response(ResponseRejection::InputInvalid));
        }
        self.read(|records, now| {
            Ok(records
                .find_response(request_id)?
                .filter(|r| now < r.response_expires_at_ms))
        })
    }
}

fn validate_fence<E>(
    attempt_id: &str,
    endpoint: &RequestEndpoint,
    input: &SubmitResponse,
) -> Result<(), RequestError<E>> {
    if attempt_id != input.attempt_id {
        return Err(RequestError::Response(ResponseRejection::AttemptMismatch));
    }
    if endpoint != &input.endpoint {
        return Err(RequestError::Response(ResponseRejection::RecipientMismatch));
    }
    Ok(())
}
