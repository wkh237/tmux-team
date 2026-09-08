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

pub enum Selector {
    Explicit(String),
    Pane(String),
}

fn required_failure() -> Failure {
    Failure::new(
        "IDENTITY_REQUIRED",
        "An identity is required; use --identity or run from a verified bound pane.",
        1,
    )
}

/// Reject an unavailable implicit caller before opening or migrating storage.
pub fn required(explicit: Option<&str>) -> Result<Selector, Failure> {
    select(&Tmux::default(), explicit)?.ok_or_else(required_failure)
}

pub fn resolve(storage: &mut Storage, selector: Selector) -> Result<Identity, Failure> {
    selected(storage, &Tmux::default(), selector)?.ok_or_else(required_failure)
}

pub fn optional(
    storage: &mut Storage,
    tmux: &Tmux,
    explicit: Option<&str>,
) -> Result<Option<Identity>, Failure> {
    match select(tmux, explicit)? {
        Some(selector) => selected(storage, tmux, selector),
        None => Ok(None),
    }
}

fn select(tmux: &Tmux, explicit: Option<&str>) -> Result<Option<Selector>, Failure> {
    if let Some(name) = explicit {
        return Ok(Some(Selector::Explicit(name.to_owned())));
    }
    tmux.caller_pane(&CallerEnvironment::current())
        .map(|pane| pane.map(Selector::Pane))
        .map_err(endpoint_failure)
}

fn selected(
    storage: &mut Storage,
    tmux: &Tmux,
    selector: Selector,
) -> Result<Option<Identity>, Failure> {
    match selector {
        Selector::Explicit(name) => storage
            .find_identity(&normalize_name(&name))
            .map_err(|error| {
                Failure::new("IDENTITY_ERROR", "Could not read identity storage.", 1)
                    .caused_by(error)
            })?
            .ok_or_else(|| missing(&name))
            .map(Some),
        Selector::Pane(pane) => {
            let observed = binding::pane_presence(storage, &mut BindingSession::new(tmux), &pane)
                .map_err(binding_failure)?;
            Ok(observed.identity)
        }
    }
}
