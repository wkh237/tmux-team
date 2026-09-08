//! Durable selectors are not pane routing or identity creation.

use crate::{
    binding_error::{binding_failure, endpoint_failure},
    output::Failure,
};
use tmt_adapters::{
    storage::Storage,
    tmux::{BindingSession, CallerEnvironment, Tmux},
};
use tmt_core::{
    binding,
    identity::{Identity, IdentityReader},
    names::normalize_name,
};

pub fn missing(name: &str) -> Failure {
    Failure::new(
        "NAME_NOT_FOUND",
        format!("Identity '{name}' was not found."),
        3,
    )
}

pub fn resolve(storage: &mut Storage, explicit: Option<&str>) -> Result<Identity, Failure> {
    optional(storage, &Tmux::default(), explicit)?.ok_or_else(|| {
        Failure::new(
            "IDENTITY_REQUIRED",
            "An identity is required; use --identity or run from a verified bound pane.",
            1,
        )
    })
}

pub fn optional(
    storage: &mut Storage,
    tmux: &Tmux,
    explicit: Option<&str>,
) -> Result<Option<Identity>, Failure> {
    if let Some(name) = explicit {
        return storage
            .find_identity(&normalize_name(name))
            .map_err(|error| {
                Failure::new("IDENTITY_ERROR", "Could not read identity storage.", 1)
                    .caused_by(error)
            })?
            .ok_or_else(|| missing(name))
            .map(Some);
    }
    let pane = tmux
        .caller_pane(&CallerEnvironment::current())
        .map_err(endpoint_failure)?;
    if let Some(pane) = pane {
        let observed = binding::pane_presence(storage, &mut BindingSession::new(tmux), &pane)
            .map_err(binding_failure)?;
        if let Some(identity) = observed.identity {
            return Ok(Some(identity));
        }
    }
    Ok(None)
}
