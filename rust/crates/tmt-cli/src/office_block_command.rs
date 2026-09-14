//! One-shot Office block composition; all authorization remains in the companion.

use crate::{
    invocation::{OfficeBlockOperation, OfficeBlockTarget, OfficeOperation, OutputMode},
    office_pairing_command::{pairing_error, resolve_identity, sync_before_operation},
    output::Failure,
};
use std::{
    io::{self, Write},
    path::Path,
    time::{Duration, Instant},
};
use tmt_adapters::{
    interrupt::Interrupt,
    office_block::{read_layout_file, read_local_layout_file},
    office_companion::{PairingCall, invoke_local_office_block, invoke_office_block},
};

pub fn run(executable: &Path, operation: OfficeOperation, mode: OutputMode) -> Result<u8, Failure> {
    let OfficeOperation::Block {
        target,
        identity: selector,
        operation,
    } = operation
    else {
        return Err(Failure::new(
            "USAGE_ERROR",
            "Expected an Office block operation.",
            1,
        ));
    };

    let (block_id, edit) = match operation {
        OfficeBlockOperation::Show { block_id } => (block_id, None),
        OfficeBlockOperation::Apply {
            block_id,
            file,
            if_revision,
        } => (block_id, Some((file, if_revision))),
    };
    let identity = resolve_identity(selector.as_deref())?;
    let interrupt = Interrupt::install().map_err(unavailable)?;
    if matches!(target, OfficeBlockTarget::Remote { .. }) {
        sync_before_operation(executable)?;
    }
    if interrupt.is_interrupted() {
        return Err(crate::office_pairing_command::interrupted());
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    let value = match target {
        OfficeBlockTarget::Remote { world, emulator } => {
            let call = PairingCall {
                world: &world,
                identity_id: &identity.id,
                emulator,
                read_only: false,
            };
            let snapshot = match edit.as_ref() {
                Some((file, revision)) => {
                    let layout = read_layout_file(Path::new(file)).map_err(pairing_error)?;
                    invoke_office_block(
                        executable,
                        &call,
                        block_id.as_deref(),
                        Some((&layout, *revision)),
                        deadline,
                    )
                }
                None => invoke_office_block(executable, &call, block_id.as_deref(), None, deadline),
            }
            .map_err(remote_unavailable)?
            .map_err(block_error)?;
            snapshot.public_value()
        }
        OfficeBlockTarget::Local => {
            let editing = edit.is_some();
            let result = match edit.as_ref() {
                Some((file, revision)) => {
                    let layout = read_local_layout_file(Path::new(file)).map_err(pairing_error)?;
                    invoke_local_office_block(
                        executable,
                        &identity.id,
                        Some((&layout, *revision)),
                        deadline,
                    )
                }
                None => invoke_local_office_block(executable, &identity.id, None, deadline),
            };
            result
                .map_err(|error| local_unavailable(error, editing))?
                .map_err(|error| local_block_error(error, &identity.name))?
        }
    };
    if interrupt.is_interrupted() {
        return Err(crate::office_pairing_command::interrupted());
    }
    let output = if mode.json {
        value.to_string()
    } else {
        serde_json::to_string_pretty(&value).map_err(unavailable)?
    };
    writeln!(io::stdout().lock(), "{output}").map_err(unavailable)?;
    Ok(0)
}

fn local_unavailable(error: impl std::error::Error + 'static, editing: bool) -> Failure {
    let (code, message) = if editing {
        (
            "OFFICE_LOCAL_UNCERTAIN",
            "Local Office did not confirm the block edit. Read the current revision before retrying.",
        )
    } else {
        ("OFFICE_IO_ERROR", "Could not read local Office state.")
    };
    Failure::new(code, message, 1).caused_by(error)
}

fn local_block_error(error: tmt_core::office_protocol::OfficeError, name: &str) -> Failure {
    if error == tmt_core::office_protocol::OfficeError::IdentityInactive {
        return crate::identity_context::missing(name);
    }
    block_error(error)
}

fn unavailable(error: impl std::error::Error + 'static) -> Failure {
    Failure::new(
        "OFFICE_IO_ERROR",
        "Could not access local Office state or output.",
        1,
    )
    .caused_by(error)
}

fn remote_unavailable(error: impl std::error::Error + 'static) -> Failure {
    unconfirmed().caused_by(error)
}

fn unconfirmed() -> Failure {
    Failure::new(
        "OFFICE_REMOTE_UNCERTAIN",
        "Office did not confirm the block operation. A save may have reached the server. Keep your draft and read the current block before retrying the original revision and intent.",
        1,
    )
}

fn block_error(error: tmt_core::office_protocol::OfficeError) -> Failure {
    if error == tmt_core::office_protocol::OfficeError::RemoteUncertain {
        return unconfirmed();
    }
    pairing_error(error)
}
