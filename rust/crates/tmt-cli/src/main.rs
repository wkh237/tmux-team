mod binding_command;
mod binding_error;
mod check_command;
mod config_command;
mod diagnostics;
mod exchange_command;
mod grammar;
mod guidance_command;
mod identity_command;
mod identity_context;
mod init_command;
mod install_command;
mod invocation;
mod native_install_command;
mod native_upgrade_command;
mod output;
mod parser;
mod profile_command;
mod response_command;
mod skill_refresh_command;
mod skill_reminder;
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
    skill_reminder::emit(&parsed);
    let mut stdout = io::stdout().lock();
    match parsed.invocation {
        Invocation::Help => {
            writeln!(
                stdout,
                "TMT native alpha — collaborate with terminal agents through durable exchanges.\nRun tmt install to set up agent skills; managed installations use tmt upgrade.\n"
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
        Invocation::Init => {
            drop(stdout);
            return init_command::execute(parsed.mode);
        }
        Invocation::Learn { skill } => {
            drop(stdout);
            return guidance_command::execute(skill);
        }
        Invocation::Install {
            target,
            directory,
            force,
        } => {
            drop(stdout);
            return install_command::execute(target, directory, force, parsed.mode);
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
        Invocation::Upgrade {
            channel,
            exact,
            unpin,
        } => {
            drop(stdout);
            return native_upgrade_command::execute(channel, exact.as_deref(), unpin, parsed.mode);
        }
        Invocation::NativeRefreshSkills => {
            drop(stdout);
            return skill_refresh_command::execute(parsed.mode);
        }
        Invocation::NativeInstall {
            archive,
            manifest,
            prefix,
            channel,
            pin,
        } => {
            drop(stdout);
            return native_install_command::execute(
                &archive,
                &manifest,
                &prefix,
                channel,
                pin,
                parsed.mode,
            );
        }
    }
    Ok(0)
}

fn failure(mode: OutputMode, code: &'static str, message: &str) -> io::Result<u8> {
    // Parse and existing configuration failures retain their exit-1 contract.
    output::Failure::new(code, message, 1).publish(mode)
}
