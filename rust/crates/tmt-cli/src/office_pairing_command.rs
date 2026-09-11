//! Public pairing composition; no credentials, HTTP or OS-store dependencies.

use crate::{
    identity_context,
    invocation::{OfficeOperation, OutputMode},
    output::Failure,
};
use std::{
    io::{self, Write},
    path::Path,
    time::{Duration, Instant},
};
use tmt_adapters::{
    config::ConfigPaths,
    interrupt::Interrupt,
    office_companion::{PairingCall, PairingReply, invoke_office_pairing},
    storage::Storage,
};
use tmt_core::office_protocol::{OfficeError, OfficeInvocation};

pub fn run(executable: &Path, operation: OfficeOperation, mode: OutputMode) -> Result<u8, Failure> {
    let inspect = matches!(&operation, OfficeOperation::Inspect { .. });
    let (world, identity, emulator, read_only, timeout, pair) = match operation {
        OfficeOperation::Pair {
            world,
            identity,
            emulator,
            read_only,
            timeout_seconds,
        } => (world, identity, emulator, read_only, timeout_seconds, true),
        OfficeOperation::PairStatus {
            world,
            identity,
            emulator,
        } => (world, identity, emulator, false, 30, false),
        OfficeOperation::Inspect {
            world,
            identity,
            emulator,
        } => (world, identity, emulator, false, 30, false),
        _ => {
            return Err(Failure::new(
                "USAGE_ERROR",
                "Expected an Office pairing operation.",
                1,
            ));
        }
    };
    let selector = identity_context::required(identity.as_deref())?;
    let paths = ConfigPaths::discover().map_err(unavailable)?;
    let mut storage = Storage::open(paths.database).map_err(unavailable)?;
    let identity = identity_context::resolve(&mut storage, selector)?;
    storage.close().map_err(unavailable)?;
    let call = PairingCall {
        world: &world,
        identity_id: &identity.id,
        emulator,
        read_only,
    };
    let interrupt = Interrupt::install().map_err(unavailable)?;
    let deadline = Instant::now() + Duration::from_secs(timeout);
    let mut operation = if pair {
        OfficeInvocation::PairBegin
    } else if inspect {
        OfficeInvocation::Inspect
    } else {
        OfficeInvocation::PairStatus
    };
    loop {
        if interrupt.is_interrupted() {
            return Err(interrupted());
        }
        if Instant::now() >= deadline {
            return Err(pairing_error(OfficeError::PairingPending));
        }
        let result = invoke_office_pairing(
            executable,
            operation,
            &call,
            deadline.min(Instant::now() + Duration::from_secs(30)),
        );
        if interrupt.is_interrupted() {
            return Err(interrupted());
        }
        let reply = result.map_err(|_| Failure::new("OFFICE_REMOTE_UNCERTAIN", "Office did not confirm the operation. Retry the same pairing; no new approval was requested.", 1))?;
        match reply {
            PairingReply::Inspected(exists) if inspect => {
                let value = serde_json::json!({"blockExists":exists,"identityId":identity.id,"world":world,"serverAuthorizationChecked":true});
                writeln!(
                    io::stdout().lock(),
                    "{}",
                    if mode.json {
                        value.to_string()
                    } else {
                        format!("Office access confirmed. Assigned block exists: {exists}.")
                    }
                )
                .map_err(unavailable)?;
                return Ok(0);
            }
            PairingReply::Inspected(_) => {
                return Err(pairing_error(OfficeError::CredentialsInvalid));
            }
            PairingReply::Pending(link) if pair => {
                if mode.json {
                    writeln!(io::stderr().lock(), "{link}")
                        .and_then(|()| io::stderr().flush())
                        .map_err(unavailable)?;
                } else {
                    writeln!(
                        io::stdout().lock(),
                        "Approve this identity in your browser:\n{link}"
                    )
                    .and_then(|()| io::stdout().flush())
                    .map_err(unavailable)?;
                }
            }
            PairingReply::State(state) if !inspect && (!pair || state == "credential") => {
                let value = serde_json::json!({"state":state,"identityId":identity.id,"world":world,"serverAuthorizationChecked":false});
                writeln!(io::stdout().lock(), "{}", if mode.json { value.to_string() } else { format!("Office pairing: {state}. Server authorization is checked when accessing a resource.") }).map_err(unavailable)?;
                return Ok(0);
            }
            PairingReply::Error(OfficeError::PairingPending | OfficeError::RemoteUncertain)
                if pair && operation == OfficeInvocation::PairPoll => {}
            PairingReply::Error(error) => return Err(pairing_error(error)),
            PairingReply::Pending(_) | PairingReply::State(_) => {
                return Err(pairing_error(OfficeError::CredentialsInvalid));
            }
        }
        operation = OfficeInvocation::PairPoll;
        interrupt
            .wait_until(deadline.min(Instant::now() + Duration::from_secs(5)))
            .map_err(unavailable)?;
    }
}

fn pairing_error(error: OfficeError) -> Failure {
    let message = match error {
        OfficeError::PairingPending => {
            "Pairing is not yet confirmed. Retry the same command within the original approval window."
        }
        OfficeError::CredentialsUnavailable => {
            "The OS credential store or local Office state is unavailable. Unlock or configure your OS credential store before pairing."
        }
        OfficeError::PairingExpired => {
            "The retained pairing or grant has expired. No new pairing was created."
        }
        OfficeError::NotPaired => "This active identity has no Office pairing.",
        _ => {
            "Office could not validate the operation. Retained pairing state was not intentionally deleted."
        }
    };
    Failure::new(error.code(), message, 1)
}

fn unavailable(error: impl std::error::Error + 'static) -> Failure {
    Failure::new(
        "OFFICE_IO_ERROR",
        "Could not access local Office state or output.",
        1,
    )
    .caused_by(error)
}

fn interrupted() -> Failure {
    Failure::new(
        "OFFICE_INTERRUPTED",
        "Office pairing interrupted. Retry the same command to inspect or resume retained state.",
        130,
    )
}
