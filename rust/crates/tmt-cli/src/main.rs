mod binding_command;
mod binding_error;
mod check_command;
mod config_command;
mod diagnostics;
mod exchange_command;
mod grammar;
mod identity_command;
mod identity_context;
mod invocation;
mod output;
mod parser;
mod profile_command;
mod response_command;
mod talk_command;
mod target;

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
                "Native development preview: configuration, identity create/show/list, talk/reply/result, pane identity name/this/add/whoami/unbind/rm/list, diagnostic check/read, role/preamble, and x attention are available. Installation commands are not implemented yet. Use isolated test state only.\n"
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
        Invocation::Config(request) => {
            drop(stdout);
            return config_command::execute(request, parsed.mode);
        }
        Invocation::Identity(request) => {
            drop(stdout);
            return identity_command::execute(request, parsed.mode);
        }
        Invocation::Exchange {
            identity,
            operation,
        } => {
            drop(stdout);
            return exchange_command::execute(identity, operation, parsed.mode);
        }
        request @ Invocation::Talk { .. } => {
            drop(stdout);
            return talk_command::execute(request, parsed.mode);
        }
        request @ (Invocation::Role { .. } | Invocation::Preamble(_)) => {
            drop(stdout);
            return profile_command::execute(request, parsed.mode);
        }
        Invocation::Check { target, lines } => {
            drop(stdout);
            return check_command::execute(target, lines, parsed.mode);
        }
        request @ (Invocation::Reply { .. } | Invocation::Result { .. }) => {
            drop(stdout);
            return response_command::execute(request, parsed.mode);
        }
        request @ (Invocation::Bind { .. }
        | Invocation::Whoami
        | Invocation::Unbind
        | Invocation::Remove { .. }
        | Invocation::List { .. }) => {
            drop(stdout);
            return binding_command::execute(request, parsed.mode);
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

fn failure(mode: OutputMode, code: &'static str, message: &str) -> io::Result<u8> {
    // Parse and existing configuration failures retain their exit-1 contract.
    output::Failure::new(code, message, 1).publish(mode)
}
