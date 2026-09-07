mod diagnostics;
mod grammar;
mod invocation;
mod parser;

use std::io::{self, Write};
use std::process::ExitCode;

use invocation::{Invocation, OutputMode};

fn main() -> ExitCode {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    let result = match parser::parse(&args) {
        Ok(parsed) => execute(parsed),
        Err(error) => failure(error.mode, error.code, &error.message),
    };
    match result {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            // Output-stream failures cannot reliably produce another document.
            let _ = writeln!(io::stderr().lock(), "Could not write CLI output: {error}");
            ExitCode::FAILURE
        }
    }
}

fn execute(parsed: invocation::Parsed) -> io::Result<u8> {
    let mut stdout = io::stdout().lock();
    match parsed.invocation {
        Invocation::Help => {
            writeln!(
                stdout,
                "Native development preview: effectful commands are not implemented yet.\n"
            )?;
            grammar::public_grammar(&grammar::grammar(), true).write_long_help(&mut stdout)?;
            writeln!(stdout)?;
        }
        Invocation::Version => writeln!(stdout, "{}", env!("CARGO_PKG_VERSION"))?,
        Invocation::Completion(shell) => {
            let shell = match shell.as_deref() {
                Some("bash") => Some(clap_complete::Shell::Bash),
                Some("zsh") => Some(clap_complete::Shell::Zsh),
                _ => None,
            };
            if let Some(shell) = shell {
                clap_complete::generate(
                    shell,
                    &mut grammar::public_grammar(&grammar::grammar(), true),
                    "tmt",
                    &mut stdout,
                );
            } else {
                writeln!(
                    stdout,
                    "Use 'tmt completion bash' or 'tmt completion zsh' to generate a shell script."
                )?;
            }
        }
        _ => {
            drop(stdout);
            return failure(
                parsed.mode,
                "NATIVE_NOT_IMPLEMENTED",
                "This command is not implemented by the native development preview. No effects were performed; use the installed TypeScript CLI until native cutover.",
            );
        }
    }
    Ok(0)
}

fn failure(mode: OutputMode, code: &str, message: &str) -> io::Result<u8> {
    if mode.json {
        let document = serde_json::json!({"error": {"code": code, "message": message}});
        writeln!(io::stdout().lock(), "{document}")?;
    } else {
        writeln!(io::stderr().lock(), "{message}")?;
    }
    Ok(1)
}
