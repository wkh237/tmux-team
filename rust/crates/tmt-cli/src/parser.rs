use std::ffi::OsString;

use clap::{ArgMatches, Command, parser::ValueSource};
use tmt_core::limits::{
    MAX_CAPTURE_LINES, MAX_JS_SAFE_INTEGER, is_valid_observer_timeout_seconds,
    is_valid_timer_delay_ms,
};

use crate::{grammar::grammar, invocation::*};

#[cfg(test)]
#[path = "parser_tests.rs"]
mod tests;

pub fn parse(argv: &[OsString]) -> Result<Parsed, ParseError> {
    let definition = grammar();
    let mut parser = definition.clone();
    let arguments = std::iter::once(OsString::from("tmt")).chain(argv.iter().cloned());
    let matches = match parser.try_get_matches_from_mut(arguments) {
        Ok(matches) => matches,
        Err(error) => {
            let mode = crate::diagnostics::error_mode(&definition, argv);
            return Err(ParseError {
                code: "USAGE_ERROR",
                message: error.to_string(),
                mode,
            });
        }
    };
    let mode = mode(&matches);
    let fail = |message: String| ParseError {
        code: "USAGE_ERROR",
        message,
        mode,
    };
    let mut leaf = &matches;
    let mut command = &definition;
    let mut path = Vec::new();
    let mut chain = vec![&matches];
    while let Some((name, submatches)) = leaf.subcommand() {
        path.push(name);
        command = command
            .find_subcommand(name)
            .expect("parsed command belongs to grammar");
        leaf = submatches;
        chain.push(leaf);
    }
    if supplied(leaf, "wait") {
        return Err(fail("The --wait option is retired. talk waits for a durable reply by default; use --timeout or --detach.".into()));
    }
    validate_options(command, &chain, path.is_empty()).map_err(fail)?;
    if path.first() == Some(&"team") || text(leaf, "team").is_some() {
        return Err(ParseError {
            code: "UNSUPPORTED_TEAM",
            message: "Team workflows are not supported.".into(),
            mode,
        });
    }
    let invocation = translate(&path, leaf).map_err(fail)?;
    if mode.json
        && matches!(
            invocation,
            Invocation::Help
                | Invocation::Version
                | Invocation::Completion(_)
                | Invocation::Learn { .. }
        )
    {
        return Err(ParseError {
            code: "JSON_UNSUPPORTED",
            message: "This command does not support --json.".into(),
            mode,
        });
    }
    Ok(Parsed { invocation, mode })
}

fn validate_options(command: &Command, chain: &[&ArgMatches], root: bool) -> Result<(), String> {
    for matches in chain {
        for id in matches.ids() {
            if !supplied(matches, id.as_str()) {
                continue;
            }
            let allowed = if root {
                crate::grammar::root_allowed(id.as_str())
            } else {
                command.get_arguments().any(|arg| arg.get_id() == id)
            };
            // Parent subcommand IDs are not options.
            if !allowed && matches.subcommand_name() != Some(id.as_str()) {
                return Err(format!(
                    "Unknown option or argument '{id}' for {}.",
                    command.get_name()
                ));
            }
        }
    }
    Ok(())
}

fn mode(matches: &ArgMatches) -> OutputMode {
    let mut leaf = matches;
    while let Some((_, child)) = leaf.subcommand() {
        leaf = child;
    }
    OutputMode {
        json: flag(leaf, "json"),
    }
}

fn supplied(matches: &ArgMatches, id: &str) -> bool {
    matches.try_contains_id(id).unwrap_or(false)
        && matches.value_source(id) == Some(ValueSource::CommandLine)
}

fn flag(matches: &ArgMatches, id: &str) -> bool {
    matches
        .try_get_one::<bool>(id)
        .ok()
        .flatten()
        .copied()
        .unwrap_or(false)
}

fn text(matches: &ArgMatches, id: &str) -> Option<String> {
    matches.try_get_one::<String>(id).ok().flatten().cloned()
}

fn required(matches: &ArgMatches, id: &str) -> String {
    text(matches, id).expect("required grammar operand was validated")
}

fn translate(path: &[&str], m: &ArgMatches) -> Result<Invocation, String> {
    Ok(match path {
        [] if flag(m, "version") => Invocation::Version,
        [] | ["help"] | ["team"] => Invocation::Help,
        ["completion"] => Invocation::Completion(text(m, "shell")),
        ["learn"] => Invocation::Learn {
            skill: flag(m, "skill"),
        },
        ["init"] => Invocation::Init,
        ["whoami"] => Invocation::Whoami,
        ["unbind"] => Invocation::Unbind,
        ["upgrade"] => Invocation::Upgrade {
            channel: text(m, "channel")
                .and_then(|value| tmt_core::native_install::Channel::parse(&value)),
            exact: text(m, "to"),
            unpin: flag(m, "unpin"),
        },
        ["office"]
        | ["office", "status"]
        | ["office", "pair"]
        | ["office", "unpair"]
        | ["office", "inspect"]
        | ["office", "sync"]
        | ["office", "block", "show"]
        | ["office", "block", "apply"]
        | ["office", "install"]
        | ["office", "upgrade"]
        | ["office", "uninstall"] => Invocation::Office {
            prefix: text(m, "prefix"),
            operation: match path.last().copied() {
                Some("sync") => OfficeOperation::Sync,
                Some("show") if path.get(1) == Some(&"block") => OfficeOperation::Block {
                    world: required(m, "world"),
                    identity: text(m, "identity"),
                    emulator: flag(m, "emulator"),
                    operation: OfficeBlockOperation::Show {
                        block_id: text(m, "block-id"),
                    },
                },
                Some("apply") if path.get(1) == Some(&"block") => OfficeOperation::Block {
                    world: required(m, "world"),
                    identity: text(m, "identity"),
                    emulator: flag(m, "emulator"),
                    operation: OfficeBlockOperation::Apply {
                        block_id: text(m, "block-id"),
                        file: required(m, "file"),
                        if_revision: *m
                            .get_one::<u64>("if-revision")
                            .expect("grammar supplies block revision"),
                    },
                },
                Some("unpair") => OfficeOperation::Unpair {
                    world: required(m, "world"),
                    identity: text(m, "identity"),
                    emulator: flag(m, "emulator"),
                },
                Some("inspect") => OfficeOperation::Inspect {
                    world: required(m, "world"),
                    identity: text(m, "identity"),
                    emulator: flag(m, "emulator"),
                },
                Some("status") => match text(m, "world") {
                    Some(world) => OfficeOperation::PairStatus {
                        world,
                        identity: text(m, "identity"),
                        emulator: flag(m, "emulator"),
                    },
                    None => OfficeOperation::Status,
                },
                Some("pair") => OfficeOperation::Pair {
                    world: required(m, "world"),
                    identity: text(m, "identity"),
                    emulator: flag(m, "emulator"),
                    read_only: flag(m, "read-only"),
                    timeout_seconds: *m
                        .get_one::<u64>("timeout")
                        .expect("grammar supplies pairing timeout"),
                },
                Some("install") => OfficeOperation::Install {
                    yes: flag(m, "yes"),
                    archive: text(m, "archive"),
                    manifest: text(m, "manifest"),
                    channel: text(m, "channel")
                        .and_then(|value| tmt_core::native_install::Channel::parse(&value)),
                },
                Some("upgrade") => OfficeOperation::Upgrade {
                    channel: text(m, "channel")
                        .and_then(|value| tmt_core::native_install::Channel::parse(&value)),
                },
                Some("uninstall") => OfficeOperation::Uninstall {
                    yes: flag(m, "yes"),
                },
                _ => OfficeOperation::Open,
            },
        },
        ["__native-refresh-skills"] => Invocation::NativeRefreshSkills,
        ["__native-install"] => Invocation::NativeInstall {
            product: tmt_core::native_install::Product::parse(&required(m, "product"))
                .expect("product was validated by grammar"),
            archive: required(m, "archive"),
            manifest: required(m, "manifest"),
            prefix: required(m, "prefix"),
            channel: tmt_core::native_install::Channel::parse(&required(m, "channel"))
                .expect("channel was validated by grammar"),
            pin: if flag(m, "pin") {
                tmt_core::native_install::PinAction::PinCandidate
            } else if flag(m, "unpin") {
                tmt_core::native_install::PinAction::Clear
            } else {
                tmt_core::native_install::PinAction::Preserve
            },
        },
        ["list"] => Invocation::List {
            target: text(m, "target"),
        },
        ["name"] | ["add"] => Invocation::Bind {
            pane: text(m, "pane-target"),
            name: required(m, "name"),
            save: flag(m, "save"),
        },
        ["rm"] => Invocation::Remove {
            name: required(m, "name"),
            force: flag(m, "force"),
        },
        ["talk"] => {
            let timeout = text(m, "timeout")
                .map(|value| duration(&value))
                .transpose()?;
            let delay = text(m, "delay").map(|value| duration(&value)).transpose()?;
            if flag(m, "detach") && timeout.is_some() {
                return Err("Use either --timeout or --detach, not both.".into());
            }
            if timeout.is_some_and(|value| !is_valid_observer_timeout_seconds(value)) {
                return Err(
                    "Talk timeout must be finite, positive, and no greater than 24 hours.".into(),
                );
            }
            if delay.is_some_and(|value| !is_valid_timer_delay_ms(value * 1000.0)) {
                return Err("Talk delay exceeds the supported timer limit.".into());
            }
            Invocation::Talk {
                target: required(m, "target"),
                message: required(m, "message"),
                originator: text(m, "identity"),
                options: TalkOptions {
                    force: flag(m, "force"),
                    detach: flag(m, "detach"),
                    delay_seconds: delay,
                    timeout_seconds: timeout,
                    no_preamble: flag(m, "no-preamble"),
                },
            }
        }
        ["check"] => {
            let positional = text(m, "capture-lines")
                .map(|value| integer(&value, "lines", 0, MAX_CAPTURE_LINES))
                .transpose()?;
            let flagged = text(m, "lines")
                .map(|value| integer(&value, "lines", 0, MAX_CAPTURE_LINES))
                .transpose()?;
            Invocation::Check {
                target: required(m, "target"),
                lines: positional.or(flagged),
            }
        }
        ["config"] | ["config", "show"] => Invocation::Config(ConfigRequest::Show),
        ["config", "set"] => Invocation::Config(ConfigRequest::Set {
            key: required(m, "key"),
            value: required(m, "value"),
            global: flag(m, "global"),
        }),
        ["config", "clear"] => Invocation::Config(ConfigRequest::Clear {
            key: text(m, "key"),
        }),
        ["identity", "create"] => {
            Invocation::Identity(IdentityRequest::Create(required(m, "name")))
        }
        ["identity", "show"] => Invocation::Identity(IdentityRequest::Show(required(m, "name"))),
        ["identity", "list"] => Invocation::Identity(IdentityRequest::List),
        ["preamble"] | ["preamble", "show"] => {
            Invocation::Preamble(PreambleRequest::Show(text(m, "agent")))
        }
        ["preamble", "clear"] => Invocation::Preamble(PreambleRequest::Clear(required(m, "agent"))),
        ["preamble", "set"] => Invocation::Preamble(PreambleRequest::Set {
            name: required(m, "agent"),
            content: m
                .get_many::<String>("content")
                .expect("required content")
                .cloned()
                .collect::<Vec<_>>()
                .join(" "),
        }),
        ["role", operation] => Invocation::Role {
            identity: text(m, "identity"),
            operation: match *operation {
                "show" => RoleOperation::Show,
                "clear" => RoleOperation::Clear,
                "set" => RoleOperation::Set(content(m, "content", false)?),
                _ => unreachable!(),
            },
        },
        ["x"] | ["x", "list"] => Invocation::Exchange {
            identity: text(m, "identity"),
            operation: ExchangeOperation::List {
                limit: text(m, "limit")
                    .map(|value| {
                        integer(
                            &value,
                            "--limit",
                            1,
                            tmt_core::request::attention::MAX_LIST_LIMIT,
                        )
                    })
                    .transpose()?,
                after: text(m, "after")
                    .map(|value| integer(&value, "--after", 0, MAX_JS_SAFE_INTEGER))
                    .transpose()?,
            },
        },
        ["x", "show"] => Invocation::Exchange {
            identity: text(m, "identity"),
            operation: ExchangeOperation::Show(required(m, "request-id")),
        },
        ["x", "ackall"] => Invocation::Exchange {
            identity: text(m, "identity"),
            operation: ExchangeOperation::Ackall,
        },
        ["x", "ack"] => Invocation::Exchange {
            identity: text(m, "identity"),
            operation: ExchangeOperation::Ack {
                request_id: required(m, "request-id"),
                revision: integer(
                    &required(m, "revision"),
                    "--revision",
                    1,
                    MAX_JS_SAFE_INTEGER,
                )?,
            },
        },
        ["reply"] => Invocation::Reply {
            request_id: request_id(m)?,
            receipt: required(m, "receipt"),
            input: content(m, "message", true)?,
        },
        ["result"] => Invocation::Result {
            request_id: request_id(m)?,
        },
        ["install"] => {
            let target = text(m, "agent");
            let directory = text(m, "dir");
            if directory
                .as_ref()
                .is_some_and(|value| value.trim().is_empty())
            {
                return Err("Install directory must not be empty.".into());
            }
            if target.is_some() && directory.is_some() {
                return Err("The --dir option cannot be combined with an agent or all.".into());
            }
            Invocation::Install {
                target,
                directory,
                force: flag(m, "force"),
            }
        }
        _ => unreachable!("grammar and typed translation must agree"),
    })
}

fn content(matches: &ArgMatches, inline: &str, stdin: bool) -> Result<ContentInput, String> {
    let mut sources = Vec::new();
    if let Some(value) = text(matches, inline) {
        sources.push(ContentInput::Inline(value));
    }
    if let Some(value) = text(matches, "file") {
        sources.push(ContentInput::File(value));
    }
    if stdin && flag(matches, "stdin") {
        sources.push(ContentInput::Stdin);
    }
    if sources.len() != 1 {
        return Err(
            "Usage: select exactly one inline content, --file, or supported --stdin source.".into(),
        );
    }
    Ok(sources.remove(0))
}

fn request_id(matches: &ArgMatches) -> Result<String, String> {
    let value = required(matches, "request-id");
    if value.is_empty() || value.len() > 256 {
        return Err("Request ID must contain 1 through 256 UTF-8 bytes.".into());
    }
    Ok(value)
}

fn integer(value: &str, name: &str, minimum: u64, maximum: u64) -> Result<u64, String> {
    if !value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && let Ok(number) = value.parse::<u64>()
        && (minimum..=maximum).contains(&number)
    {
        return Ok(number);
    }
    Err(format!(
        "{name} must be a decimal integer between {minimum} and {maximum}."
    ))
}

fn duration(value: &str) -> Result<f64, String> {
    let lower = value.to_ascii_lowercase();
    let (digits, divisor) = if let Some(digits) = lower.strip_suffix("ms") {
        (digits, 1000.0)
    } else {
        (lower.strip_suffix('s').unwrap_or(&lower), 1.0)
    };
    let parts = digits.split('.').collect::<Vec<_>>();
    if parts.len() <= 2
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        && let Ok(number) = digits.parse::<f64>()
        && number.is_finite()
    {
        return Ok(number / divisor);
    }
    Err(format!(
        "Invalid time format: {value}. Use number (seconds) or number with ms/s suffix."
    ))
}
