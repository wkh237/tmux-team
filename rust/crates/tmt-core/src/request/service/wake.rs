use super::*;

impl<R: RequestRepository, C: Fn() -> u64> RequestService<'_, R, C> {
    /// Claim exactly one advisory wake while leaving the inbox request queued.
    /// A retained claim is an unknown outcome after process loss, never a retry lease.
    pub fn claim_wake(&mut self, request_id: &str) -> Result<WakeClaim, RequestError<R::Error>> {
        nonempty(request_id)?;
        self.repository.with_request_transaction(|records| {
            let attempt = records
                .find_request(request_id)?
                .ok_or(RequestError::NotFound)?;
            let state = records
                .wake_state(request_id)?
                .ok_or(RequestError::NotFound)?;
            if state != WakeState::NotAttempted {
                return Ok(WakeClaim {
                    state,
                    claimed: false,
                });
            }
            let RequestRoute::Inbox {
                recipient_identity_id,
            } = &attempt.route
            else {
                return Ok(WakeClaim {
                    state,
                    claimed: false,
                });
            };
            if attempt.kind != RequestKind::Request || attempt.status != AttemptStatus::Queued {
                return Ok(WakeClaim {
                    state,
                    claimed: false,
                });
            }
            if !records.claim_wake(request_id)? {
                return Err(RequestError::StateInvalid);
            }
            let eligible = attempt.response_submitted_at_ms.is_none()
                && records.identity_is_active(recipient_identity_id)?
                && match attempt.room_id.as_deref() {
                    Some(room) => records.room_has_recipient(room, recipient_identity_id)?,
                    None => true,
                };
            if !eligible {
                if !records.settle_wake(request_id, WakeState::Unavailable)? {
                    return Err(RequestError::StateInvalid);
                }
                return Ok(WakeClaim {
                    state: WakeState::Unavailable,
                    claimed: false,
                });
            }
            Ok(WakeClaim {
                state: WakeState::Claimed,
                claimed: true,
            })
        })
    }

    /// Recheck the accepted UUID and room after endpoint work, before pane input.
    pub fn wake_recipient_is_eligible(
        &mut self,
        request_id: &str,
        recipient_id: &str,
    ) -> Result<bool, RequestError<R::Error>> {
        nonempty(request_id)?;
        nonempty(recipient_id)?;
        self.repository.with_request_observation(|records| {
            let Some(attempt) = records.find_request(request_id)? else {
                return Ok(false);
            };
            if attempt.kind != RequestKind::Request
                || attempt.status != AttemptStatus::Queued
                || attempt.response_submitted_at_ms.is_some()
                || records.wake_state(request_id)? != Some(WakeState::Claimed)
                || !matches!(&attempt.route, RequestRoute::Inbox { recipient_identity_id } if recipient_identity_id == recipient_id)
                || !records.identity_is_active(recipient_id)?
            {
                return Ok(false);
            }
            match attempt.room_id.as_deref() {
                Some(room) => records.room_has_recipient(room, recipient_id).map_err(Into::into),
                None => Ok(true),
            }
        })
    }

    pub fn settle_wake(
        &mut self,
        request_id: &str,
        state: WakeState,
    ) -> Result<(), RequestError<R::Error>> {
        nonempty(request_id)?;
        if !matches!(
            state,
            WakeState::Sent | WakeState::Unavailable | WakeState::Uncertain
        ) {
            return Err(RequestError::StateInvalid);
        }
        self.repository.with_request_transaction(|records| {
            if records.settle_wake(request_id, state)? {
                Ok(())
            } else {
                Err(RequestError::StateInvalid)
            }
        })
    }
}
