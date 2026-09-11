//! Verified, bounded execution of the optional companion; never resolves PATH.

use crate::{
    native_install::{self, Product},
    process::{CommandRequest, RunningCommand, UnixCommandRunner},
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
    let (running, version) =
        native_install::with_active_product(Product::Office, executable, |installed| {
            start_probe(&installed.active_executable)
                .map(|running| (running, installed.state.version.clone()))
        })??;
    finish_probe(running, &version)
}

pub(crate) fn probe_candidate(
    executable: &Path,
    expected_version: &semver::Version,
) -> io::Result<String> {
    finish_probe(start_probe(executable)?, expected_version)
}

fn start_probe(executable: &Path) -> io::Result<RunningCommand> {
    let args = OfficeInvocation::Probe.arguments().map(OsString::from);
    UnixCommandRunner
        .start(CommandRequest {
            program: executable.as_os_str(),
            args: &args,
            input: &[],
            deadline: Instant::now() + Duration::from_secs(5),
            max_output_bytes: OFFICE_PROTOCOL_OUTPUT_LIMIT,
        })
        .map_err(io::Error::other)
}

fn finish_probe(running: RunningCommand, expected_version: &semver::Version) -> io::Result<String> {
    let output = running.wait().map_err(io::Error::other)?;
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
