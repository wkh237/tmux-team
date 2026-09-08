//! Current-server pane-first routing shared by diagnostic and delivery commands.

use crate::{
    binding_error::{binding_failure, endpoint_failure},
    output::Failure,
};
use tmt_adapters::{
    storage::Storage,
    tmux::{BindingSession, OperationOptions, Tmux},
};
use tmt_core::{
    binding::{self, PaneIdentity},
    endpoint::EndpointSnapshot,
    names::is_pane_target,
    request::RequestEndpoint,
};

#[cfg(test)]
mod tests;

pub fn resolve(storage: &mut Storage, tmux: &Tmux, input: &str) -> Result<PaneIdentity, Failure> {
    let mut endpoint = BindingSession::new(tmux);
    if is_pane_target(input) {
        let pane = tmux
            .resolve_target(input, OperationOptions::default())
            .map_err(endpoint_failure)?
            .ok_or_else(|| {
                Failure::new(
                    "PANE_NOT_FOUND",
                    format!("Pane target '{input}' was not found."),
                    3,
                )
            })?;
        return binding::pane_presence(storage, &mut endpoint, &pane).map_err(binding_failure);
    }
    binding::current_name_presence(storage, &mut endpoint, input)
        .map_err(binding_failure)?
        .ok_or_else(|| {
            Failure::new(
                "NAME_NOT_FOUND",
                format!("Identity '{input}' is not active."),
                3,
            )
        })
}

/// A fresh observation before preparation is not a lease on later processing.
pub fn refresh(tmux: &Tmux, observed: &PaneIdentity) -> Result<RequestEndpoint, Failure> {
    let scope = [observed.pane.id.clone()];
    let snapshot = tmux
        .snapshot(OperationOptions {
            pane_ids: Some(&scope),
            ..Default::default()
        })
        .map_err(endpoint_failure)?;
    refreshed_endpoint(observed, snapshot)
}

fn refreshed_endpoint(
    observed: &PaneIdentity,
    snapshot: EndpointSnapshot,
) -> Result<RequestEndpoint, Failure> {
    use tmt_core::{
        binding::{BindingEntry, BindingEvidence, evaluate_binding},
        endpoint::EndpointProbe,
    };
    let pane = if let Some(identity) = &observed.identity {
        let entry = BindingEntry {
            identity: identity.clone(),
            binding: observed.binding.clone(),
        };
        match evaluate_binding(&entry, &EndpointProbe::Live(snapshot.clone())) {
            BindingEvidence::Active(pane) => *pane,
            _ => {
                return Err(Failure::new(
                    "RECONCILIATION_FAILED",
                    "Recipient identity changed before request preparation.",
                    1,
                ));
            }
        }
    } else {
        snapshot
            .panes
            .iter()
            .find(|pane| pane.id == observed.pane.id)
            .cloned()
            .ok_or_else(|| {
                Failure::new(
                    "PANE_NOT_FOUND",
                    "Recipient pane disappeared before request preparation.",
                    3,
                )
            })?
    };
    Ok(RequestEndpoint {
        server: snapshot.server,
        pane_id: pane.id,
        pane_pid: pane.pane_pid,
    })
}
