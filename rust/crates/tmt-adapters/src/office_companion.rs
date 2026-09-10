//! Verified, bounded execution of the optional companion; never resolves PATH.

use crate::{
    native_install::{self, Product},
    process::{CommandRequest, CommandRunner, UnixCommandRunner},
};
use std::{
    ffi::OsString,
    io,
    path::Path,
    time::{Duration, Instant},
};
use tmt_core::office_protocol::{
    OFFICE_PROTOCOL_OUTPUT_LIMIT, OfficeInvocation, decode_office_probe,
};

/// Local compatibility inspection only: does not pair, authenticate or start a service.
pub fn probe_office_companion(executable: &Path) -> io::Result<String> {
    native_install::with_active_product(Product::Office, executable, |installed| {
        probe_candidate(&installed.active_executable, &installed.state.version)
    })?
}

pub(crate) fn probe_candidate(
    executable: &Path,
    expected_version: &semver::Version,
) -> io::Result<String> {
    let args = OfficeInvocation::Probe.arguments().map(OsString::from);
    let output = UnixCommandRunner
        .execute(CommandRequest {
            program: executable.as_os_str(),
            args: &args,
            input: &[],
            deadline: Instant::now() + Duration::from_secs(5),
            max_output_bytes: OFFICE_PROTOCOL_OUTPUT_LIMIT,
        })
        .map_err(io::Error::other)?;
    if !output.stderr.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Office handshake produced unexpected diagnostics.",
        ));
    }
    let version = decode_office_probe(&output.stdout)
        .map_err(|message| io::Error::new(io::ErrorKind::InvalidData, message))?;
    if &version != expected_version {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Office executable and installation versions disagree.",
        ));
    }
    Ok(version.to_string())
}
