//! Storage-only command composition. Identity policy and SQL remain in their
//! existing core/service and adapter owners; this layer projects public output.

use crate::{
    invocation::{IdentityRequest, OutputMode},
    output::{Failure, after_cleanup, identity_document},
};
use serde_json::json;
use std::{
    error::Error,
    io::{self, Write},
};
use tmt_adapters::{
    config::ConfigPaths,
    storage::{Storage, StorageError},
};
use tmt_core::identity::{self, Identity, IdentityError, IdentityReader, Lifetime};

enum Report {
    Created(identity::CreatedIdentity),
    Shown(Identity),
    Listed(Vec<Identity>),
}

fn unavailable(error: impl Error + 'static) -> Failure {
    Failure::new(
        "IDENTITY_ERROR",
        "Could not complete the identity operation.",
        1,
    )
    .caused_by(error)
}

fn identity_failure(error: IdentityError<StorageError>) -> Failure {
    match error {
        IdentityError::InvalidName(error) => {
            Failure::new("INVALID_NAME", error.to_string(), 1).caused_by(error)
        }
        IdentityError::Repository(error) => unavailable(error),
    }
}

fn run(request: IdentityRequest) -> Result<Report, Failure> {
    // Path discovery does not load settings. Open only for this implemented
    // capability; unported commands never reach storage or tmux construction.
    let paths = ConfigPaths::discover().map_err(unavailable)?;
    let mut storage = Storage::open(paths.database).map_err(unavailable)?;
    let pending = operation(&mut storage, request);
    after_cleanup(pending, || storage.close())
}

fn operation(storage: &mut Storage, request: IdentityRequest) -> Result<Report, Failure> {
    match request {
        IdentityRequest::Create(name) => {
            identity::create_or_resolve(storage, &name, Lifetime::Saved)
                .map(Report::Created)
                .map_err(identity_failure)
        }
        IdentityRequest::Show(name) => identity::find_by_name(storage, &name)
            .map_err(identity_failure)?
            .map(Report::Shown)
            .ok_or_else(|| {
                Failure::new(
                    "NAME_NOT_FOUND",
                    format!("Identity '{name}' was not found."),
                    3,
                )
            }),
        IdentityRequest::List => storage
            .list_identities()
            .map(Report::Listed)
            .map_err(unavailable),
    }
}

pub fn execute(request: IdentityRequest, mode: OutputMode) -> io::Result<u8> {
    let report = match run(request) {
        Ok(report) => report,
        Err(error) => return error.publish(mode),
    };
    let mut stdout = io::stdout().lock();
    if mode.json {
        let document = match report {
            Report::Created(result) => {
                json!({"identity": identity_document(&result.identity), "created": result.created})
            }
            Report::Shown(identity) => json!({"identity": identity_document(&identity)}),
            Report::Listed(identities) => {
                json!({"identities": identities.iter().map(identity_document).collect::<Vec<_>>()})
            }
        };
        writeln!(stdout, "{document}")?;
    } else {
        match report {
            Report::Created(result) => {
                let action = if result.created {
                    "Created"
                } else {
                    "Already exists:"
                };
                writeln!(
                    stdout,
                    "{action} saved identity '{}' ({}).",
                    result.identity.name, result.identity.id
                )?;
            }
            Report::Shown(identity) => {
                crate::output::table::write(
                    &mut stdout,
                    ["NAME", "LIFETIME", "CANONICAL NAME", "ID"],
                    [[
                        identity.name,
                        identity.lifetime.as_str().to_owned(),
                        identity.canonical_name,
                        identity.id,
                    ]],
                )?;
            }
            Report::Listed(identities) if identities.is_empty() => {
                writeln!(stdout, "No identities found.")?
            }
            Report::Listed(identities) => {
                crate::output::table::write(
                    &mut stdout,
                    ["NAME", "LIFETIME", "ID"],
                    identities.into_iter().map(|identity| {
                        [
                            identity.name,
                            identity.lifetime.as_str().to_owned(),
                            identity.id,
                        ]
                    }),
                )?;
            }
        }
    }
    Ok(0)
}
