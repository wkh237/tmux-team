//! Thin composition of typed commands, one storage handle and binding policy.
//! Preflight caller/target checks precede configuration and database effects.

mod presentation;

use crate::{
    binding_error::{binding_failure, endpoint_failure},
    invocation::{Invocation, OutputMode},
    output::{Failure, after_cleanup},
};
use std::io::{self, Write};
use tmt_adapters::{
    config::{ConfigFiles, ConfigPaths},
    storage::Storage,
    tmux::{BindingSession, CallerEnvironment, OperationOptions, Tmux},
};
use tmt_core::{
    binding::{self, BindingEntry, IdentityPresence, UnboundIdentity},
    endpoint::PaneObservation,
    identity::Identity,
    names::is_pane_target,
    settings::PaneBadge,
};

enum Report {
    Bound(IdentityPresence),
    Caller {
        pane: String,
        identity: Option<Identity>,
    },
    Unbound {
        pane: String,
        result: UnboundIdentity,
    },
    Removed(BindingEntry),
    Listed(Vec<IdentityPresence>),
    Named {
        target: String,
        row: IdentityPresence,
    },
    Pane {
        target: String,
        pane: PaneObservation,
        identity: Option<Identity>,
    },
}

fn preflight(
    request: &Invocation,
    tmux: &Tmux,
    environment: &CallerEnvironment,
) -> Result<Option<String>, Failure> {
    let target = match request {
        Invocation::Bind {
            pane: Some(pane),
            name,
            ..
        } => {
            if !is_pane_target(pane) && is_pane_target(name) {
                return Err(Failure::new(
                    "LEGACY_ADD_ORDER",
                    "The v4 add argument order is no longer supported.",
                    1,
                )
                .suggestion(format!("Use: tmt add {name} {pane}")));
            }
            Some(pane.as_str())
        }
        Invocation::List {
            target: Some(target),
        } if is_pane_target(target) => Some(target.as_str()),
        Invocation::Bind { pane: None, .. } | Invocation::Whoami | Invocation::Unbind => {
            return tmux
                .caller_pane(environment)
                .map_err(endpoint_failure)?
                .map(Some)
                .ok_or_else(|| {
                    Failure::new(
                        "PANE_NOT_FOUND",
                        "Not running inside a resolvable tmux pane.",
                        3,
                    )
                });
        }
        _ => None,
    };
    target
        .map(|target| {
            tmux.resolve_target(target, OperationOptions::default())
                .map_err(endpoint_failure)?
                .ok_or_else(|| {
                    Failure::new(
                        "PANE_NOT_FOUND",
                        format!("Pane target '{target}' was not found."),
                        3,
                    )
                })
        })
        .transpose()
}

fn run(request: Invocation) -> Result<Report, Failure> {
    let tmux = Tmux::default();
    let environment = CallerEnvironment::current();
    let pane = preflight(&request, &tmux, &environment)?;
    let paths = ConfigPaths::discover().map_err(Failure::from)?;
    let badge = if matches!(request, Invocation::Bind { .. }) {
        ConfigFiles {
            paths: paths.clone(),
        }
        .load()
        .map_err(Failure::from)?
        .settings
        .pane_badge
    } else {
        PaneBadge::Off
    };
    let mut storage = Storage::open(paths.database).map_err(|error| {
        Failure::new("IDENTITY_ERROR", "Could not open identity storage.", 1).caused_by(error)
    })?;
    let mut endpoint = BindingSession::new(&tmux);
    let pending = operation(&mut storage, &mut endpoint, request, pane, environment.selected_socket())
        .and_then(|report| {
            // Presentation follows successful durable effects, never decides
            // them. The adapter preserves user themes and changed endpoints.
            let update = match &report {
                Report::Bound(row) => row.binding.as_ref().map(|binding|
                    (binding, (badge == PaneBadge::On).then_some(row.identity.name.as_str()))),
                Report::Unbound { result, .. } => result.binding.as_ref().map(|binding| (binding, None)),
                Report::Removed(entry) => entry.binding.as_ref().map(|binding| (binding, None)),
                _ => None,
            };
            if let Some((binding, name)) = update {
                tmux.update_binding_badge(binding, name).map_err(|error|
                    Failure::new("CLEANUP_ERROR", "Could not clean up cosmetic operation resources. Effects may already have occurred.", 1).caused_by(error))?;
            }
            Ok(report)
        });
    after_cleanup(pending, || storage.close())
}

fn operation(
    storage: &mut Storage,
    endpoint: &mut BindingSession<'_, tmt_adapters::process::UnixCommandRunner>,
    request: Invocation,
    pane: Option<String>,
    current_socket: Option<&str>,
) -> Result<Report, Failure> {
    match request {
        Invocation::Bind { name, save, .. } => binding::bind_identity(
            storage,
            endpoint,
            pane.as_deref().expect("binding preflight"),
            &name,
            save,
        )
        .map(Report::Bound)
        .map_err(binding_failure),
        Invocation::Whoami => {
            let pane = pane.expect("caller preflight");
            let observed =
                binding::pane_presence(storage, endpoint, &pane).map_err(binding_failure)?;
            Ok(Report::Caller {
                pane,
                identity: observed.identity,
            })
        }
        Invocation::Unbind => {
            let pane = pane.expect("caller preflight");
            let result = binding::unbind_identity(storage, endpoint, &pane)
                .map_err(binding_failure)?
                .ok_or_else(|| {
                    Failure::new("UNBOUND_PANE", "Pane has no active global name.", 1)
                })?;
            Ok(Report::Unbound { pane, result })
        }
        Invocation::Remove { name, force } => {
            binding::remove_identity(storage, endpoint, &name, force)
                .map(Report::Removed)
                .map_err(binding_failure)
        }
        Invocation::List { target: None } => {
            binding::list_presence(storage, endpoint, current_socket)
                .map(Report::Listed)
                .map_err(binding_failure)
        }
        Invocation::List {
            target: Some(target),
        } => {
            if let Some(pane) = pane {
                let observed =
                    binding::pane_presence(storage, endpoint, &pane).map_err(binding_failure)?;
                Ok(Report::Pane {
                    target,
                    pane: observed.pane,
                    identity: observed.identity,
                })
            } else {
                let row =
                    binding::name_presence(storage, endpoint, &target).map_err(binding_failure)?;
                Ok(Report::Named { target, row })
            }
        }
        _ => Err(Failure::new(
            "INTERNAL_ERROR",
            "Unexpected binding command.",
            1,
        )),
    }
}

pub fn execute(request: Invocation, mode: OutputMode) -> io::Result<u8> {
    let report = match run(request) {
        Ok(report) => report,
        Err(error) => return error.publish(mode),
    };
    let mut stdout = io::stdout().lock();
    if mode.json {
        writeln!(stdout, "{}", presentation::document(&report))?;
    } else {
        presentation::text(&mut stdout, &report)?;
    }
    Ok(0)
}
