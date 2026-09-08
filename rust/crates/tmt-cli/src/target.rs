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
    names::is_pane_target,
};

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
