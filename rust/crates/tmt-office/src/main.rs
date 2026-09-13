//! Internal optional companion entrypoint. No implicit authentication or service.

use std::{
    io::{self, Read, Write},
    process::ExitCode,
};
use tmt_core::office_protocol::{OfficeInvocation, encode_office_probe};

#[cfg(feature = "local-service")]
mod local_assets;
#[cfg(feature = "local-service")]
mod local_service;

fn main() -> ExitCode {
    let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    if arguments == ["__tmt-office-service", "1", "serve"] {
        #[cfg(feature = "local-service")]
        return local_service::run();
        #[cfg(not(feature = "local-service"))]
        {
            let _ = writeln!(
                io::stderr().lock(),
                "This Office build does not include the local service."
            );
            return ExitCode::FAILURE;
        }
    }
    if arguments == ["__tmt-office-service", "1", "asset-probe"] {
        #[cfg(feature = "local-service")]
        if local_assets::prove() {
            let _ = writeln!(io::stdout().lock(), "TMT-OFFICE-LOCAL/1");
            return ExitCode::SUCCESS;
        }
        let _ = writeln!(
            io::stderr().lock(),
            "This Office build has no valid embedded local UI."
        );
        return ExitCode::FAILURE;
    }
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
        Ok(operation) => {
            let mut input = Vec::new();
            match io::stdin().lock().take(4097).read_to_end(&mut input) {
                Ok(_) => {
                    let output = if matches!(
                        operation,
                        OfficeInvocation::LocalBlockShow | OfficeInvocation::LocalBlockApply
                    ) {
                        tmt_adapters::office_local::execute(operation, &input)
                    } else {
                        tmt_adapters::office_pairing::execute(operation, &input)
                    };
                    io::stdout().lock().write_all(&output)
                }
                Err(error) => Err(error),
            }
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
