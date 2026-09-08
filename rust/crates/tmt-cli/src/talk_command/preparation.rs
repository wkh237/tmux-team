use super::*;
use crate::{identity_context, target};
use tmt_adapters::{reply_receipt::encode_short_receipt, request_runtime::request_ids};
use tmt_core::{
    profile::{ProfileKind, ProfileReader},
    request::{Originator, PreambleReservation, PrepareRequest},
    retention::{REQUEST_MIN_EXPIRY_MS, checked_deadline},
    settings::PreambleMode,
};

pub(super) fn prepare(
    storage: &mut Storage,
    tmux: &Tmux,
    input: &Input,
    settings: &Settings,
    interrupt: Option<&Interrupt>,
) -> Result<Prepared, Failure> {
    let observed = target::resolve(storage, tmux, &input.target)?;
    let originator = identity_context::optional(storage, tmux, input.originator.as_deref())?
        .map_or(Originator::Unknown, |identity| {
            if input.originator.is_some() {
                Originator::Explicit(identity.id)
            } else {
                Originator::Verified(identity.id)
            }
        });
    let (request_id, attempt_id) = request_ids();
    let correlation = Correlation {
        request_id,
        target: input.target.clone(),
        pane: observed.pane.id.clone(),
        identity: observed.identity.clone(),
    };
    if let Some(delay) = input.options.delay_seconds {
        let delay = Duration::from_secs_f64(delay);
        if let Some(interrupt) = interrupt {
            interrupt
                .wait_until(Instant::now() + delay)
                .map_err(|error| {
                    correlation
                        .error("ERROR", "Could not wait before delivery.", 1)
                        .caused_by(error)
                })?;
        } else {
            std::thread::sleep(delay);
        }
    }
    if interrupt.is_some_and(Interrupt::is_interrupted) {
        return Err(correlation.interrupted());
    }
    let preamble = if input.options.no_preamble
        || settings.preamble_mode == PreambleMode::Disabled
        || settings.preamble_every == 0
    {
        None
    } else if let Some(identity) = &observed.identity {
        storage
            .find_profile(&identity.id, ProfileKind::Preamble)
            .map_err(|error| {
                Failure::new("PREAMBLE_ERROR", "Could not read recipient preamble.", 1)
                    .caused_by(error)
            })?
            .filter(|profile| !profile.content.is_empty())
            .map(|profile| (identity.id.clone(), profile.content))
    } else {
        None
    };
    let endpoint = target::refresh(tmux, &observed)?;
    let timeout_ms = if input.options.detach {
        0
    } else {
        (input.options.timeout_seconds.unwrap_or(settings.timeout) * 1000.0).ceil() as u64
    };
    let budget = timeout_ms + settings.paste_enter_delay_ms.ceil() as u64 + 1000;
    let expires_at_ms = checked_deadline(wall_time_ms(), budget.max(REQUEST_MIN_EXPIRY_MS))
        .ok_or_else(|| {
            correlation.error(
                "CONFIG_ERROR",
                "Request expiry is outside the supported range.",
                1,
            )
        })?;
    let prepared = RequestService::new(storage, wall_time_ms)
        .prepare(
            PrepareRequest {
                request_id: correlation.request_id.clone(),
                message: input.message.clone(),
                endpoint: endpoint.clone(),
                wait: !input.options.detach,
                expires_at_ms,
                originator,
                recipient_identity_id: observed
                    .identity
                    .as_ref()
                    .map(|identity| identity.id.clone()),
                preamble: preamble
                    .as_ref()
                    .map(|(identity_id, _)| PreambleReservation {
                        identity_id: identity_id.clone(),
                        every: settings.preamble_every,
                    }),
            },
            attempt_id.clone(),
            settings.retention_days,
        )
        .map_err(|error| correlation.state_error(error, false))?;
    let receipt = encode_short_receipt(&correlation.request_id, &attempt_id, &endpoint);
    let message = if prepared.inject_preamble {
        preamble.map_or_else(
            || input.message.clone(),
            |(_, content)| format!("[SYSTEM: {content}]\n\n{}", input.message),
        )
    } else {
        input.message.clone()
    };
    let payload = format!(
        "{message}\n\n<tmt-reply>\ntmt reply {} --receipt {receipt} --message <text>\n</tmt-reply>\nSubmit your response with the command above. Chat output alone does not complete the request. After successful submission, show a brief summary; report submission errors.",
        correlation.request_id
    );
    Ok(Prepared {
        correlation,
        attempt_id,
        endpoint,
        payload,
        previous_request_id: prepared.previous_request_id,
    })
}
