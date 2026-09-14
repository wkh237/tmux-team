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
    root = root.subcommand(office_commands());
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
            general(
                "rm",
                "Retire identity and remove role/preamble; keep pane/exchanges (--force for saved)",
            ),
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
                "inbox",
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
                &["identity", "incoming"],
            )
            .arg(operand("request-id", true)),
        )
        .subcommand(
            with_options(
                storage("ack", "Acknowledge an observed revision"),
                &["identity", "incoming"],
            )
            .arg(option("revision").required(true))
            .arg(operand("request-id", true)),
        )
        .subcommand(with_options(
            storage("ackall", "Acknowledge the current identity snapshot"),
            &["identity", "incoming"],
        ))
        .subcommand(with_options(
            storage("listen", "Wait for incoming inbox activity"),
            &["identity", "timeout", "debounce"],
        )),
    )
    .subcommand(
        storage("identity", "Manage durable identity records and metadata")
            .subcommand_required(true)
            .subcommand(storage("create", "Create or save an identity").arg(operand("name", true)))
            .subcommand(storage("show", "Show an identity").arg(operand("name", true)))
            .subcommand(with_options(
                storage("list", "List non-retired identities"),
                &["where", "has"],
            ))
            .subcommand(
                storage("meta", "Manage descriptive identity metadata")
                    .subcommand_required(true)
                    .subcommand(
                        with_options(storage("set", "Set a metadata value"), &["identity"])
                            .arg(operand("key", true))
                            .arg(operand("value", true)),
                    )
                    .subcommand(
                        with_options(storage("get", "Get a metadata value"), &["identity"])
                            .arg(operand("key", true)),
                    )
                    .subcommand(with_options(
                        storage("list", "List metadata values"),
                        &["identity"],
                    ))
                    .subcommand(
                        with_options(storage("rm", "Remove a metadata value"), &["identity"])
                            .arg(operand("key", true)),
                    ),
            ),
    )
    .subcommand(
        storage("notes", "Access saved identity notes")
            .subcommand_required(true)
            .subcommand(with_options(
                storage("path", "Initialize and print the local Markdown path"),
                &["identity"],
            )),
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
        storage("result", "Retrieve a retained final response").arg(operand("request-id", true)),
    )
    .subcommand(
        with_options(
            general("install", "Install or refresh agent skills"),
            &["force", "dir"],
        )
        .arg(
            operand("agent", false)
                .value_parser(
                    tmt_core::skill_provider::Provider::ALL
                        .into_iter()
                        .map(|provider| provider.as_str())
                        .chain(["all"])
                        .collect::<Vec<_>>(),
                )
                .ignore_case(true),
        ),
    )
    .subcommand(general("completion", "Generate shell completion").arg(operand("shell", false)))
    .subcommand(
        general(
            "upgrade",
            "Upgrade the native CLI and refresh managed skills",
        )
        .visible_alias("update")
        .arg(
            Arg::new("channel").long("channel").value_parser(
                tmt_core::native_install::Channel::ALL.map(|channel| channel.as_str()),
            ),
        )
        .arg(Arg::new("to").long("to").conflicts_with("unpin"))
        .arg(Arg::new("unpin").long("unpin").action(ArgAction::SetTrue)),
    )
    .subcommand(general("__native-refresh-skills", "Internal managed skill refresh").hide(true))
    .subcommand(
        general("__native-install", "Internal offline native installation")
            .hide(true)
            .arg(
                Arg::new("product")
                    .long("product")
                    .default_value("cli")
                    .value_parser(
                        tmt_core::native_install::Product::ALL.map(|product| product.as_str()),
                    ),
            )
            .arg(Arg::new("archive").long("archive").required(true))
            .arg(Arg::new("manifest").long("manifest").required(true))
            .arg(Arg::new("prefix").long("prefix").required(true))
            .arg(
                Arg::new("channel")
                    .long("channel")
                    .required(true)
                    .value_parser(
                        tmt_core::native_install::Channel::ALL.map(|channel| channel.as_str()),
                    ),
            )
            .arg(
                Arg::new("pin")
                    .long("pin")
                    .action(ArgAction::SetTrue)
                    .conflicts_with("unpin"),
            )
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
    with_options(storage(name, about), &["wait", "team"])
}

fn office(name: &'static str, about: &'static str) -> Command {
    general(name, about).arg(Arg::new("prefix").long("prefix").global(true))
}

fn office_commands() -> Command {
    office("office", "Manage the optional Office companion")
        .subcommand(
            office("start", "Start or reuse the local Office service").arg(
                Arg::new("port")
                    .long("port")
                    .value_parser(clap::value_parser!(u16).range(1..)),
            ),
        )
        .subcommand(office("stop", "Stop the local Office service"))
        .subcommand(office_scope(
            office("unpair", "Revoke the selected identity's Office pairing"),
            true,
        ))
        .subcommand(office(
            "sync",
            "Deliver pending identity retirement hooks to Office",
        ))
        .subcommand(
            office("block", "Read or edit an Office block")
                .subcommand(office_block_scope(
                    office("show", "Show the selected Office block")
                        .arg(operand("block-id", false)),
                ))
                .subcommand(office_block_scope(
                    office("apply", "Apply a complete layout to an Office block")
                        .arg(operand("block-id", false))
                        .arg(Arg::new("file").long("file").required(true))
                        .arg(
                            Arg::new("if-revision")
                                .long("if-revision")
                                .required(true)
                                .value_parser(
                                    clap::value_parser!(u64)
                                        .range(0..tmt_core::office_block::MAX_REVISION),
                                ),
                        ),
                )),
        )
        .subcommand(
            office(
                "profile",
                "Read or edit a local Office presentation profile",
            )
            .subcommand(
                office(
                    "show",
                    "Show the selected identity's local presentation profile",
                )
                .arg(
                    Arg::new("local")
                        .long("local")
                        .required(true)
                        .action(ArgAction::SetTrue),
                )
                .arg(option("identity")),
            )
            .subcommand(
                office(
                    "apply",
                    "Apply the selected identity's local presentation profile",
                )
                .arg(
                    Arg::new("local")
                        .long("local")
                        .required(true)
                        .action(ArgAction::SetTrue),
                )
                .arg(option("identity"))
                .arg(Arg::new("file").long("file").required(true))
                .arg(
                    Arg::new("if-revision")
                        .long("if-revision")
                        .required(true)
                        .value_parser(
                            clap::value_parser!(u64)
                                .range(0..=tmt_core::office_profile::MAX_REVISION),
                        ),
                ),
            ),
        )
        .subcommand(office_prop_commands())
        .subcommand(office_avatar_commands())
        .subcommand(office_board_commands())
        .subcommand(office_scope(
            office(
                "inspect",
                "Check access to the paired identity's assigned block",
            ),
            true,
        ))
        .subcommand(office_scope(
            office("status", "Inspect installation or local pairing state"),
            false,
        ))
        .subcommand(
            office_scope(
                office(
                    "pair",
                    "Pair an existing identity with a private Office world",
                ),
                true,
            )
            .arg(
                Arg::new("read-only")
                    .long("read-only")
                    .action(ArgAction::SetTrue),
            )
            .arg(
                Arg::new("timeout")
                    .long("timeout")
                    .default_value("300")
                    .value_parser(clap::value_parser!(u64).range(1..=300)),
            ),
        )
        .subcommand(
            with_options(
                office("install", "Explicitly install the Office companion"),
                &["force"],
            )
            .arg(Arg::new("yes").long("yes").action(ArgAction::SetTrue))
            .arg(Arg::new("archive").long("archive").requires("manifest"))
            .arg(Arg::new("manifest").long("manifest").requires("archive"))
            .arg(Arg::new("channel").long("channel").value_parser(
                tmt_core::native_install::Channel::ALL.map(|channel| channel.as_str()),
            )),
        )
        .subcommand(
            with_options(
                office("upgrade", "Explicitly update the Office companion"),
                &["force"],
            )
            .arg(Arg::new("channel").long("channel").value_parser(
                tmt_core::native_install::Channel::ALL.map(|channel| channel.as_str()),
            )),
        )
        .subcommand(
            office(
                "uninstall",
                "Deactivate Office without deleting retained data",
            )
            .arg(Arg::new("yes").long("yes").action(ArgAction::SetTrue)),
        )
}

fn office_prop_commands() -> Command {
    let local = |command: Command| {
        command.arg(
            Arg::new("local")
                .long("local")
                .required(true)
                .action(ArgAction::SetTrue),
        )
    };
    let revision = |command: Command| {
        command.arg(
            Arg::new("if-revision")
                .long("if-revision")
                .required(true)
                .value_parser(
                    clap::value_parser!(u64).range(0..=tmt_core::limits::MAX_JS_SAFE_INTEGER),
                ),
        )
    };
    office("prop", "Manage local data-only Office prop packs")
        .subcommand(
            office("validate", "Validate one bounded data-only prop pack")
                .arg(Arg::new("file").long("file").required(true)),
        )
        .subcommand(
            office(
                "preview",
                "Preview one prop pack in the running local Office",
            )
            .arg(Arg::new("file").long("file").required(true)),
        )
        .subcommand(revision(local(
            office("install", "Install one prop pack into the local catalog")
                .arg(Arg::new("file").long("file").required(true)),
        )))
        .subcommand(revision(local(
            office("remove", "Remove one installed prop pack").arg(operand("prop-digest", true)),
        )))
        .subcommand(
            local(office("list", "List the local prop catalog"))
                .arg(
                    Arg::new("prop-limit")
                        .long("limit")
                        .default_value("20")
                        .value_parser(clap::value_parser!(u64).range(1..=20)),
                )
                .arg(Arg::new("cursor").long("cursor")),
        )
        .subcommand(
            local(office("show", "Show one local or built-in prop pack"))
                .arg(operand("prop-digest", true)),
        )
}

fn office_avatar_commands() -> Command {
    let local = |command: Command| {
        command.arg(
            Arg::new("local")
                .long("local")
                .required(true)
                .action(ArgAction::SetTrue),
        )
    };
    let revision = |command: Command| {
        command.arg(
            Arg::new("if-revision")
                .long("if-revision")
                .required(true)
                .value_parser(
                    clap::value_parser!(u64).range(0..=tmt_core::limits::MAX_JS_SAFE_INTEGER),
                ),
        )
    };
    office("avatar", "Manage local data-only Office avatar packs")
        .subcommand(
            office("validate", "Validate one bounded data-only avatar pack")
                .arg(Arg::new("file").long("file").required(true)),
        )
        .subcommand(
            office(
                "preview",
                "Preview one avatar pack in the running local Office",
            )
            .arg(Arg::new("file").long("file").required(true)),
        )
        .subcommand(revision(local(
            office("install", "Install one avatar pack into the local catalog")
                .arg(Arg::new("file").long("file").required(true)),
        )))
        .subcommand(revision(local(
            office("remove", "Remove one installed avatar pack")
                .arg(operand("avatar-digest", true)),
        )))
        .subcommand(
            local(office("list", "List the local avatar catalog"))
                .arg(
                    Arg::new("avatar-limit")
                        .long("limit")
                        .default_value("20")
                        .value_parser(clap::value_parser!(u64).range(1..=20)),
                )
                .arg(Arg::new("cursor").long("cursor")),
        )
        .subcommand(
            local(office("show", "Show one installed avatar pack"))
                .arg(operand("avatar-digest", true)),
        )
}

fn office_board_commands() -> Command {
    let category = |command: Command| {
        command
            .arg(Arg::new("repo").long("repo"))
            .arg(
                Arg::new("general")
                    .long("general")
                    .action(ArgAction::SetTrue),
            )
            .group(
                clap::ArgGroup::new("board-category")
                    .args(["repo", "general"])
                    .required(true),
            )
    };
    let actor = |command: Command| {
        command
            .arg(option("identity"))
            .arg(Arg::new("owner").long("owner").action(ArgAction::SetTrue))
            .group(clap::ArgGroup::new("board-actor").args(["identity", "owner"]))
    };
    let body = |command: Command, required: bool| {
        command
            .arg(Arg::new("body").long("body").allow_hyphen_values(true))
            .arg(Arg::new("file").long("file").allow_hyphen_values(true))
            .group(
                clap::ArgGroup::new("board-body")
                    .args(["body", "file"])
                    .required(required),
            )
    };
    let operation = |command: Command| command.arg(Arg::new("operation-id").long("operation-id"));
    let revision = |command: Command| {
        command.arg(
            Arg::new("if-revision")
                .long("if-revision")
                .required(true)
                .value_parser(clap::value_parser!(u64).range(1..)),
        )
    };
    office("board", "Use the local Office discussion board")
        .subcommand(operation(body(
            actor(
                category(office("post", "Post a board thread")).arg(
                    Arg::new("title")
                        .long("title")
                        .required(true)
                        .allow_hyphen_values(true),
                ),
            ),
            true,
        )))
        .subcommand(category(
            office("list", "List board threads")
                .arg(
                    Arg::new("view")
                        .long("view")
                        .default_value("recent")
                        .value_parser(["recent", "updated"]),
                )
                .arg(
                    Arg::new("author-id")
                        .long("author-id")
                        .conflicts_with("owner"),
                )
                .arg(Arg::new("owner").long("owner").action(ArgAction::SetTrue))
                .arg(Arg::new("since").long("since"))
                .arg(
                    Arg::new("board-limit")
                        .long("limit")
                        .default_value("20")
                        .value_parser(clap::value_parser!(u32).range(1..=50)),
                )
                .arg(Arg::new("cursor").long("cursor")),
        ))
        .subcommand(
            office("show", "Show a board thread")
                .arg(operand("thread-id", true))
                .arg(
                    Arg::new("reply-limit")
                        .long("reply-limit")
                        .default_value("20")
                        .value_parser(clap::value_parser!(u32).range(1..=50)),
                )
                .arg(Arg::new("reply-cursor").long("reply-cursor")),
        )
        .subcommand(operation(body(
            actor(office("reply", "Reply to a board thread").arg(operand("thread-id", true))),
            true,
        )))
        .subcommand(operation(revision(
            body(
                actor(
                    office("edit", "Edit a board entry")
                        .arg(operand("entry-id", true))
                        .arg(Arg::new("title").long("title").allow_hyphen_values(true)),
                ),
                false,
            )
            .group(
                clap::ArgGroup::new("board-edit-fields")
                    .args(["title", "body", "file"])
                    .multiple(true)
                    .required(true),
            ),
        )))
        .subcommand(operation(revision(actor(
            office("delete", "Delete a board entry")
                .arg(operand("entry-id", true))
                .arg(
                    Arg::new("moderate")
                        .long("moderate")
                        .requires("owner")
                        .action(ArgAction::SetTrue),
                ),
        ))))
}

fn office_block_scope(command: Command) -> Command {
    command
        .arg(Arg::new("world").long("world").conflicts_with("local"))
        .arg(
            Arg::new("local")
                .long("local")
                .conflicts_with_all(["world", "emulator", "block-id"])
                .action(ArgAction::SetTrue),
        )
        .arg(option("identity"))
        .arg(
            Arg::new("emulator")
                .long("emulator")
                .requires("world")
                .action(ArgAction::SetTrue),
        )
        .group(
            clap::ArgGroup::new("office-block-target")
                .args(["world", "local"])
                .required(true),
        )
}

fn office_scope(command: Command, required: bool) -> Command {
    command
        .arg(Arg::new("world").long("world").required(required))
        .arg(option("identity").requires("world"))
        .arg(
            Arg::new("emulator")
                .long("emulator")
                .requires("world")
                .action(ArgAction::SetTrue),
        )
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
    matches!(id, "json" | "help" | "version" | "team")
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
        "force" => {
            flag("Authorize the command's documented protected replacement or removal").short('f')
        }
        "save" => flag("Preserve this identity after its pane is gone").short('s'),
        "help" => flag("Show help").short('h').hide(true),
        "version" => flag("Show version").short('V').hide(true),
        "wait" => flag("Retired; use timeout or detach").hide(true),
        "detach" => flag("Return after sending"),
        "inbox" => flag("Queue for an identity without tmux delivery"),
        "incoming" => flag("Use recipient-facing request attention"),
        "no-preamble" => flag("Skip the recipient preamble"),
        "stdin" => flag("Read complete input through EOF"),
        "skill" => Arg::new(id)
            .long(id)
            .help("Print an exact bundled skill (default: tmux-team)")
            .num_args(0..=1)
            .default_missing_value("tmux-team")
            .value_parser(["tmux-team", "tmt-inbox", "tmt-office", "tmt-prop-create"]),
        "global" => flag("Edit global settings").short('g'),
        "config" => value("Unsupported path override").hide(true),
        "team" => value("Retired scope").hide(true),
        "timeout" => value("Observer timeout in seconds or with ms/s/m suffix"),
        "delay" => value("Pre-send delay in seconds or with ms/s/m suffix"),
        "debounce" => value("Trailing quiet interval in seconds or with ms/s/m suffix"),
        "lines" => value("Diagnostic capture line count"),
        "identity" => value("Select an explicit identity").global(true),
        "file" => value("Read content from a regular file"),
        "message" => value("Submit exact inline content"),
        "receipt" => value("Receipt supplied by talk"),
        "dir" => value("Custom skills directory"),
        "limit" => value("Maximum exchanges, 1 through 200").global(true),
        "after" => value("List revisions after this cursor").global(true),
        "revision" => value("Observed revision to acknowledge"),
        "where" => Arg::new(id)
            .long(id)
            .help("Require exact metadata KEY=VALUE")
            .action(ArgAction::Append),
        "has" => Arg::new(id)
            .long(id)
            .help("Require a metadata KEY")
            .action(ArgAction::Append),
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
