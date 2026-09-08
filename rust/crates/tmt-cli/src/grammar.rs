use clap::{Arg, ArgAction, Command};

// This tree owns recognition, help, completion and allowed-option validation.
// Root-recognized options are inherited for placement, not universal permission.
pub fn grammar() -> Command {
    let mut root = Command::new("tmt")
        .about("Collaborate with agents through durable tmux exchanges")
        .disable_help_flag(true)
        .disable_version_flag(true)
        .disable_help_subcommand(true)
        .args_override_self(true);
    for id in [
        "json",
        "verbose",
        "debug",
        "force",
        "config",
        "delay",
        "wait",
        "detach",
        "timeout",
        "lines",
        "no-preamble",
        "team",
        "help",
        "version",
    ] {
        root = root.arg(option(id).global(true));
    }
    root.subcommand(general("help", "Show help"))
        .subcommand(
            general("team", "Retired command")
                .hide(true)
                .arg(operand("scope", false)),
        )
        .subcommand(general("init", "Create workspace settings"))
        .subcommand(
            general("list", "List global identities, lifetime and live presence")
                .visible_alias("ls")
                .arg(operand("target", false)),
        )
        .subcommand(
            with_options(
                general("add", "Bind an explicit pane; temporary unless saved"),
                &["save"],
            )
            .arg(operand("pane-target", true))
            .arg(operand("name", true)),
        )
        .subcommand(
            with_options(
                general("name", "Bind this pane; temporary unless saved"),
                &["save"],
            )
            .visible_alias("this")
            .arg(operand("name", true)),
        )
        .subcommand(
            with_options(
                general("rm", "Retire identity and remove role/preamble; keep pane/exchanges (--force for saved)"),
                &["force"],
            )
            .visible_alias("remove")
            .arg(operand("name", true)),
        )
        .subcommand(
            with_options(
                general("talk", "Send a request and wait for its durable reply"),
                &[
                    "force",
                    "delay",
                    "detach",
                    "timeout",
                    "no-preamble",
                    "identity",
                ],
            )
            .visible_alias("send")
            .arg(operand("target", true))
            .arg(operand("message", true)),
        )
        .subcommand(
            with_options(
                general("check", "Capture diagnostic pane output"),
                &["lines"],
            )
            .visible_alias("read")
            .arg(operand("target", true))
            .arg(operand("capture-lines", false)),
        )
        .subcommand(general("whoami", "Show this pane's verified identity"))
        .subcommand(general(
            "unbind",
            "Detach this pane; retire temporary identity",
        ))
        .subcommand(
            general("config", "View or modify settings")
                .subcommand(general("show", "Show settings"))
                .subcommand(
                    with_options(general("set", "Set a setting"), &["global"])
                        .arg(operand("key", true))
                        .arg(operand("value", true).allow_negative_numbers(true)),
                )
                .subcommand(general("clear", "Clear a local setting").arg(operand("key", false))),
        )
        .subcommand(
            general("preamble", "Manage identity-owned preambles")
                .subcommand(general("show", "Show preambles").arg(operand("agent", false)))
                .subcommand(
                    general("set", "Set a preamble")
                        .arg(operand("agent", true))
                        .arg(operand("content", true).num_args(1..)),
                )
                .subcommand(general("clear", "Clear a preamble").arg(operand("agent", true))),
        )
        .subcommand(
            with_options(
                storage("x", "Inspect and acknowledge exchanges"),
                &["identity", "limit", "after"],
            )
            .subcommand(with_options(
                storage("list", "List unacknowledged exchanges"),
                &["identity", "limit", "after"],
            ))
            .subcommand(
                with_options(
                    storage("show", "Show retained exchange content"),
                    &["identity"],
                )
                .arg(operand("request-id", true)),
            )
            .subcommand(
                with_options(
                    storage("ack", "Acknowledge an observed revision"),
                    &["identity"],
                )
                .arg(option("revision").required(true))
                .arg(operand("request-id", true)),
            )
            .subcommand(with_options(
                storage("ackall", "Acknowledge the current identity snapshot"),
                &["identity"],
            )),
        )
        .subcommand(
            storage("identity", "Manage identity records without probing tmux")
                .subcommand_required(true)
                .subcommand(
                    storage("create", "Create or save an identity").arg(operand("name", true)),
                )
                .subcommand(storage("show", "Show an identity").arg(operand("name", true)))
                .subcommand(storage("list", "List non-retired identities")),
        )
        .subcommand(
            with_options(general("role", "Manage role profiles"), &["identity"])
                .subcommand_required(true)
                .subcommand(with_options(general("show", "Show a role"), &["identity"]))
                .subcommand(
                    with_options(
                        general("set", "Set a role from inline text or file"),
                        &["identity", "file"],
                    )
                    .arg(operand("content", false)),
                )
                .subcommand(with_options(
                    general("clear", "Clear a role"),
                    &["identity"],
                )),
        )
        .subcommand(
            with_options(
                storage("reply", "Submit an exact final response"),
                &["file", "message", "stdin"],
            )
            .arg(option("receipt").required(true))
            .arg(operand("request-id", true)),
        )
        .subcommand(
            storage("result", "Retrieve a retained final response")
                .arg(operand("request-id", true)),
        )
        .subcommand(
            with_options(
                general("install", "Install or refresh agent skills"),
                &["force", "dir"],
            )
            .arg(operand("agent", false).value_parser(
                tmt_core::skill_provider::Provider::ALL.into_iter().map(|provider| provider.as_str()).chain(["all"]).collect::<Vec<_>>()
            ).ignore_case(true)),
        )
        .subcommand(general("completion", "Generate shell completion").arg(operand("shell", false)))
        .subcommand(general("upgrade", "Upgrade the CLI and refresh skills"))
        .subcommand(
            general("__native-install", "Internal offline native installation")
                .hide(true)
                .arg(Arg::new("archive").long("archive").required(true))
                .arg(Arg::new("manifest").long("manifest").required(true))
                .arg(Arg::new("prefix").long("prefix").required(true))
                .arg(Arg::new("channel").long("channel").required(true).value_parser(["stable", "alpha"]))
                .arg(Arg::new("pin").long("pin").action(ArgAction::SetTrue).conflicts_with("unpin"))
                .arg(Arg::new("unpin").long("unpin").action(ArgAction::SetTrue)),
        )
        .subcommand(with_options(
            general("learn", "Read agent guidance"),
            &["skill"],
        ))
}

fn base(name: &'static str, about: &'static str) -> Command {
    Command::new(name)
        .about(about)
        .disable_help_flag(true)
        .disable_version_flag(true)
        .disable_help_subcommand(true)
        .args_override_self(true)
}

fn storage(name: &'static str, about: &'static str) -> Command {
    base(name, about).arg(option("json"))
}

fn general(name: &'static str, about: &'static str) -> Command {
    with_options(storage(name, about), &["verbose", "debug", "wait", "team"])
}

fn with_options(mut command: Command, ids: &[&'static str]) -> Command {
    for id in ids {
        command = command.arg(option(id));
    }
    command
}

fn operand(id: &'static str, required: bool) -> Arg {
    Arg::new(id).required(required)
}

pub fn root_allowed(id: &str) -> bool {
    matches!(
        id,
        "json" | "verbose" | "debug" | "help" | "version" | "team"
    )
}

/// Completion generators include hidden and inherited arguments. Project only
/// advertised, command-owned arguments so rejection-only syntax is never offered.
pub fn public_grammar(definition: &Command, root: bool) -> Command {
    let mut result = Command::new(definition.get_name().to_owned())
        .disable_help_flag(true)
        .disable_version_flag(true)
        .disable_help_subcommand(true)
        .visible_aliases(definition.get_visible_aliases().map(str::to_owned));
    if let Some(about) = definition.get_about() {
        result = result.about(about.clone());
    }
    for argument in definition.get_arguments() {
        if !argument.is_hide_set() && (!root || root_allowed(argument.get_id().as_str())) {
            result = result.arg(argument.clone().global(false));
        }
    }
    for child in definition
        .get_subcommands()
        .filter(|child| !child.is_hide_set())
    {
        result = result.subcommand(public_grammar(child, false));
    }
    result
}

fn option(id: &'static str) -> Arg {
    let flag = |description: &'static str| {
        Arg::new(id)
            .long(id)
            .help(description)
            .action(ArgAction::SetTrue)
    };
    let value = |description: &'static str| {
        Arg::new(id)
            .long(id)
            .help(description)
            .action(ArgAction::Set)
            .allow_hyphen_values(matches!(
                id,
                "config" | "delay" | "timeout" | "lines" | "team"
            ))
    };
    match id {
        "json" => flag("Output one JSON document"),
        "verbose" => flag("Show detailed output").short('v'),
        "debug" => flag("Show diagnostics"),
        "force" => flag("Confirm saved-identity removal or skip advisory warnings").short('f'),
        "save" => flag("Preserve this identity after its pane is gone").short('s'),
        "help" => flag("Show help").short('h').hide(true),
        "version" => flag("Show version").short('V').hide(true),
        "wait" => flag("Retired; use timeout or detach").hide(true),
        "detach" => flag("Return after sending"),
        "no-preamble" => flag("Skip the recipient preamble"),
        "stdin" => flag("Read complete input through EOF"),
        "skill" => flag("Print the canonical skill"),
        "global" => flag("Edit global settings").short('g'),
        "config" => value("Unsupported path override").hide(true),
        "team" => value("Retired scope").hide(true),
        "timeout" => value("Observer timeout in seconds or with ms/s suffix"),
        "delay" => value("Pre-send delay in seconds or with ms/s suffix"),
        "lines" => value("Diagnostic capture line count"),
        "identity" => value("Select an explicit identity").global(true),
        "file" => value("Read content from a regular file"),
        "message" => value("Submit exact inline content"),
        "receipt" => value("Receipt supplied by talk"),
        "dir" => value("Custom skills directory"),
        "limit" => value("Maximum exchanges, 1 through 200").global(true),
        "after" => value("List revisions after this cursor").global(true),
        "revision" => value("Observed revision to acknowledge"),
        _ => unreachable!("unknown grammar option"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grammar_is_internally_consistent() {
        grammar().debug_assert();
    }
}
