//! Internal optional companion entrypoint. No implicit authentication or service.

use std::{
    io::{self, Write},
    process::ExitCode,
};
use tmt_core::office_protocol::{OfficeInvocation, encode_office_probe};

fn main() -> ExitCode {
    let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    let text = arguments
        .iter()
        .map(|arg| arg.to_str())
        .collect::<Option<Vec<_>>>();
    let invocation = text
        .as_deref()
        .ok_or("Office arguments must be UTF-8.")
        .and_then(OfficeInvocation::parse);
    let result = match invocation {
        Ok(OfficeInvocation::Probe) => {
            let version = env!("CARGO_PKG_VERSION")
                .parse()
                .expect("Cargo validates the package version");
            io::stdout()
                .lock()
                .write_all(encode_office_probe(&version).as_bytes())
        }
        Err(message) => {
            let _ = writeln!(io::stderr().lock(), "{message}");
            return ExitCode::FAILURE;
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => ExitCode::FAILURE,
    }
}
