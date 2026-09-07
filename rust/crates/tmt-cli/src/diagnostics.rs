use std::ffi::OsString;

use clap::{Arg, Command};

use crate::invocation::OutputMode;

/// Recover only presentation mode after Clap rejects an invocation. Clap stops
/// at unknown options, whereas the reference parser can retain later flags.
/// Arity and scope come from the same grammar; this never constructs requests,
/// repairs invalid input, dispatches commands or inspects option-value contents.
pub fn error_mode(definition: &Command, argv: &[OsString]) -> OutputMode {
    let mut mode = OutputMode::default();
    let mut commands = vec![definition];
    let mut tokens = argv.iter().peekable();
    let mut can_descend = true;
    while let Some(token) = tokens.next() {
        let Some(token) = token.to_str() else {
            continue;
        };
        if token == "--" {
            break;
        }
        if let Some(long) = token.strip_prefix("--") {
            let (name, inline) = long
                .split_once('=')
                .map_or((long, false), |(name, _)| (name, true));
            if let Some(option) = find_option(&commands, |arg| arg.get_long() == Some(name)) {
                if option.get_action().takes_values() {
                    if !inline
                        && tokens.peek().is_some_and(|value| {
                            option.is_allow_hyphen_values_set()
                                || value
                                    .to_str()
                                    .is_none_or(|value| !value.starts_with('-') || value == "-")
                        })
                    {
                        tokens.next();
                    }
                } else if !inline {
                    record(&mut mode, option);
                }
            }
        } else if let Some(short) = token.strip_prefix('-') {
            let mut chars = short.chars().peekable();
            while let Some(short) = chars.next() {
                if let Some(option) = find_option(&commands, |arg| arg.get_short() == Some(short)) {
                    if option.get_action().takes_values() {
                        if chars.peek().is_none() {
                            tokens.next();
                        }
                        break;
                    }
                    record(&mut mode, option);
                }
            }
        } else if can_descend {
            if let Some(child) = commands
                .last()
                .and_then(|command| command.find_subcommand(token))
            {
                commands.push(child);
            } else {
                // Later positional data must not select a command after an
                // unknown root operand or the start of a leaf's operands.
                can_descend = false;
            }
        }
    }
    mode
}

fn find_option<'a>(commands: &[&'a Command], predicate: impl Fn(&Arg) -> bool) -> Option<&'a Arg> {
    commands
        .iter()
        .rev()
        .enumerate()
        .find_map(|(index, command)| {
            command
                .get_arguments()
                .find(|arg| (index == 0 || arg.is_global_set()) && predicate(arg))
        })
}

fn record(mode: &mut OutputMode, option: &Arg) {
    match option.get_id().as_str() {
        "json" => mode.json = true,
        "verbose" => mode.verbose = true,
        "debug" => mode.debug = true,
        _ => {}
    }
}
