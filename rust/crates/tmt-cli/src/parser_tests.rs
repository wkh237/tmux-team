use std::ffi::OsString;

use super::{
    ContentInput, ExchangeOperation, Invocation, OutputMode, ParseError, Parsed, RoleOperation,
    TalkOptions, parse,
};

fn args(values: &[&str]) -> Vec<OsString> {
    values.iter().map(OsString::from).collect()
}

#[test]
fn native_upgrade_alias_and_selection_share_one_typed_contract() {
    for command in ["upgrade", "update"] {
        let invocation = parsed(&[
            command,
            "--channel",
            "alpha",
            "--to",
            "5.0.0-alpha.3",
            "--json",
        ]);
        assert!(invocation.mode.json);
        assert_eq!(
            invocation.invocation,
            Invocation::Upgrade {
                channel: Some(tmt_core::native_install::Channel::Alpha),
                exact: Some("5.0.0-alpha.3".into()),
                unpin: false,
            }
        );
        assert_eq!(
            parsed(&[command, "--unpin"]).invocation,
            Invocation::Upgrade {
                channel: None,
                exact: None,
                unpin: true
            }
        );
        assert_eq!(
            parse_error(&[command, "--to", "5.0.0", "--unpin", "--json"]).code,
            "USAGE_ERROR"
        );
        assert_eq!(
            parse_error(&[command, "--channel", "beta", "--json"]).code,
            "USAGE_ERROR"
        );
    }
}

#[test]
fn internal_native_install_requires_explicit_inputs_and_typed_pin_policy() {
    use tmt_core::native_install::{Channel, PinAction};
    let input = [
        "__native-install",
        "--archive",
        "archive.tar.gz",
        "--manifest",
        "manifest.json",
        "--prefix",
        "/prefix with spaces",
        "--channel",
        "alpha",
        "--json",
    ];
    let parsed = parsed(&input);
    assert!(parsed.mode.json);
    assert_eq!(
        parsed.invocation,
        Invocation::NativeInstall {
            archive: "archive.tar.gz".into(),
            manifest: "manifest.json".into(),
            prefix: "/prefix with spaces".into(),
            channel: Channel::Alpha,
            pin: PinAction::Preserve,
        }
    );
    for pin in ["--pin", "--unpin"] {
        let mut args = input.to_vec();
        args.push(pin);
        let result = super::parse(&self::args(&args)).unwrap();
        assert!(
            matches!(result.invocation, Invocation::NativeInstall { pin: actual, .. }
            if actual == if pin == "--pin" { PinAction::PinCandidate } else { PinAction::Clear })
        );
    }
    let mut conflict = input.to_vec();
    conflict.extend(["--pin", "--unpin"]);
    assert_eq!(parse_error(&conflict).code, "USAGE_ERROR");
    assert_eq!(parse_error(&["__native-install"]).code, "USAGE_ERROR");
    let help = crate::grammar::public_grammar(&crate::grammar::grammar(), true);
    assert!(help.find_subcommand("__native-install").is_none());
}

#[test]
fn negative_config_values_reach_setting_validation_without_accepting_unknown_flags() {
    let invocation = parsed(&["config", "set", "preambleEvery", "-1", "--json"]);
    assert_eq!(
        invocation.invocation,
        Invocation::Config(crate::invocation::ConfigRequest::Set {
            key: "preambleEvery".into(),
            value: "-1".into(),
            global: false,
        })
    );
    assert!(invocation.mode.json);
    assert_eq!(
        parse_error(&["config", "set", "preambleEvery", "--unknown", "--json"]).code,
        "USAGE_ERROR"
    );
}

fn parsed(values: &[&str]) -> Parsed {
    parse(&args(values)).unwrap_or_else(|error| {
        panic!("expected {:?} to parse, got {error:?}", values);
    })
}

#[test]
fn preamble_operands_join_without_reparsing_literal_content() {
    use crate::invocation::PreambleRequest;
    for (args, content) in [
        (
            vec!["preamble", "set", "Alice", "first", "second"],
            "first second",
        ),
        (
            vec!["preamble", "set", "Alice", "--", "--json", "literal"],
            "--json literal",
        ),
    ] {
        let parsed = parsed(&args);
        assert_eq!(
            parsed.invocation,
            Invocation::Preamble(PreambleRequest::Set {
                name: "Alice".into(),
                content: content.into()
            })
        );
        assert!(!parsed.mode.json);
    }
    assert_eq!(
        parsed(&["preamble"]).invocation,
        Invocation::Preamble(PreambleRequest::Show(None))
    );
    assert_eq!(
        parsed(&["preamble", "show", "Alice"]).invocation,
        Invocation::Preamble(PreambleRequest::Show(Some("Alice".into())))
    );
}

fn parse_error(values: &[&str]) -> ParseError {
    parse(&args(values)).expect_err("expected arguments to be rejected")
}

fn assert_usage_error(values: &[&str], message: &str, mode: OutputMode) {
    let error = parse_error(values);
    assert_eq!(error.code, "USAGE_ERROR", "arguments: {values:?}");
    assert_eq!(error.mode, mode, "arguments: {values:?}");
    assert!(
        error.message.contains(message),
        "arguments: {values:?}; expected message containing {message:?}, got {:?}",
        error.message
    );
}

#[test]
fn command_aliases_preserve_typed_invocations() {
    let cases = [
        ("ls alias", vec!["ls"], Invocation::List { target: None }),
        (
            "this alias",
            vec!["this", "Alice"],
            Invocation::Bind {
                pane: None,
                name: "Alice".into(),
                save: false,
            },
        ),
        (
            "remove alias",
            vec!["remove", "Alice"],
            Invocation::Remove {
                name: "Alice".into(),
                force: false,
            },
        ),
        (
            "send alias",
            vec!["send", "peer", "hello"],
            Invocation::Talk {
                target: "peer".into(),
                message: "hello".into(),
                originator: None,
                options: TalkOptions {
                    force: false,
                    detach: false,
                    delay_seconds: None,
                    timeout_seconds: None,
                    no_preamble: false,
                },
            },
        ),
        (
            "read alias",
            vec!["read", "peer", "0"],
            Invocation::Check {
                target: "peer".into(),
                lines: Some(0),
            },
        ),
    ];

    for (name, argv, invocation) in cases {
        let actual = parsed(&argv);
        assert_eq!(actual.invocation, invocation, "{name}");
        assert_eq!(actual.mode, OutputMode::default(), "{name} mode");
    }
}

#[test]
fn save_and_force_flags_have_false_defaults_and_short_aliases() {
    assert_eq!(
        parsed(&["add", "%1", "Alice"]).invocation,
        Invocation::Bind {
            pane: Some("%1".into()),
            name: "Alice".into(),
            save: false,
        }
    );
    assert_eq!(
        parsed(&["add", "%1", "Alice", "-s"]).invocation,
        Invocation::Bind {
            pane: Some("%1".into()),
            name: "Alice".into(),
            save: true,
        }
    );
    assert_eq!(
        parsed(&["name", "Alice", "--save"]).invocation,
        Invocation::Bind {
            pane: None,
            name: "Alice".into(),
            save: true,
        }
    );
    assert_eq!(
        parsed(&["rm", "Alice"]).invocation,
        Invocation::Remove {
            name: "Alice".into(),
            force: false,
        }
    );
    assert_eq!(
        parsed(&["remove", "Alice", "-f"]).invocation,
        Invocation::Remove {
            name: "Alice".into(),
            force: true,
        }
    );
}

#[test]
fn literal_option_words_remain_data_when_the_grammar_requires_values() {
    assert_eq!(
        parsed(&["talk", "peer", "--", "--json --debug"]).invocation,
        Invocation::Talk {
            target: "peer".into(),
            message: "--json --debug".into(),
            originator: None,
            options: TalkOptions {
                force: false,
                detach: false,
                delay_seconds: None,
                timeout_seconds: None,
                no_preamble: false,
            },
        }
    );
    assert_eq!(
        parsed(&[
            "reply",
            "request-1",
            "--receipt",
            "receipt",
            "--message=--json"
        ])
        .invocation,
        Invocation::Reply {
            request_id: "request-1".into(),
            receipt: "receipt".into(),
            input: ContentInput::Inline("--json".into()),
        }
    );
}

#[test]
fn root_and_command_local_options_work_before_and_after_the_command() {
    assert_eq!(
        parsed(&["--json", "--debug", "talk", "peer", "hello", "--detach"]).mode,
        OutputMode {
            json: true,
            verbose: false,
            debug: true,
        }
    );
    assert_eq!(
        parsed(&[
            "talk",
            "peer",
            "hello",
            "--json",
            "--debug",
            "--no-preamble"
        ]),
        Parsed {
            invocation: Invocation::Talk {
                target: "peer".into(),
                message: "hello".into(),
                originator: None,
                options: TalkOptions {
                    force: false,
                    detach: false,
                    delay_seconds: None,
                    timeout_seconds: None,
                    no_preamble: true,
                },
            },
            mode: OutputMode {
                json: true,
                verbose: false,
                debug: true,
            },
        }
    );
    assert_eq!(
        parsed(&["--timeout", "2", "send", "peer", "hello"]).invocation,
        Invocation::Talk {
            target: "peer".into(),
            message: "hello".into(),
            originator: None,
            options: TalkOptions {
                force: false,
                detach: false,
                delay_seconds: None,
                timeout_seconds: Some(2.0),
                no_preamble: false,
            },
        }
    );
}

#[test]
fn command_local_options_are_rejected_at_the_wrong_boundary() {
    for (argv, text) in [
        (
            &["list", "--force"][..],
            "Unknown option or argument 'force'",
        ),
        (
            &["role", "show", "--force"][..],
            "Unknown option or argument 'force'",
        ),
        (
            &["list", "--delay", "1"][..],
            "Unknown option or argument 'delay'",
        ),
        (
            &["role", "show", "--no-preamble"][..],
            "Unknown option or argument 'no-preamble'",
        ),
        (
            &["read", "peer", "--timeout", "2"][..],
            "Unknown option or argument 'timeout'",
        ),
    ] {
        assert_usage_error(argv, text, OutputMode::default());
    }
}

#[test]
fn missing_arguments_keep_json_mode_before_or_after_the_command() {
    for argv in [
        &["--json", "name"][..],
        &["name", "--json"][..],
        &["--json", "talk", "peer"][..],
        &["talk", "peer", "--json"][..],
    ] {
        assert_usage_error(
            argv,
            "required",
            OutputMode {
                json: true,
                verbose: false,
                debug: false,
            },
        );
    }
}

#[test]
fn local_missing_values_do_not_swallow_root_presentation_flags() {
    for argv in [
        &["talk", "peer", "--identity", "--json", "hello"][..],
        &["talk", "peer", "--identity", "--json", "hello", "--nope"][..],
        &[
            "no-command",
            "talk",
            "peer",
            "--identity",
            "--json",
            "--nope",
        ][..],
    ] {
        let error = parse_error(argv);
        assert_eq!(error.code, "USAGE_ERROR", "{argv:?}");
        assert!(error.mode.json, "{argv:?}: {error:?}");
    }
    let result = parsed(&["talk", "peer", "--identity=--json", "hello"]);
    assert!(!result.mode.json);
    let Invocation::Talk {
        originator,
        message,
        ..
    } = result.invocation
    else {
        panic!("expected talk request");
    };
    assert_eq!(originator.as_deref(), Some("--json"));
    assert_eq!(message, "hello");
    let error = parse_error(&["learn", "--config", "--json"]);
    assert!(!error.mode.json);
    assert!(error.message.contains("config"));
}

#[test]
fn retired_wait_and_team_paths_have_distinct_errors() {
    let wait = parse_error(&["talk", "peer", "hello", "--wait"]);
    assert_eq!(wait.code, "USAGE_ERROR");
    assert_eq!(wait.mode, OutputMode::default());
    assert!(wait.message.contains("--wait option is retired"));

    let team = parse_error(&["team", "legacy"]);
    assert_eq!(team.code, "UNSUPPORTED_TEAM");
    assert_eq!(team.mode, OutputMode::default());
    assert_eq!(team.message, "Team workflows are not supported.");

    let scoped = parse_error(&["--json", "--team", "legacy", "list"]);
    assert_eq!(scoped.code, "UNSUPPORTED_TEAM");
    assert_eq!(
        scoped.mode,
        OutputMode {
            json: true,
            verbose: false,
            debug: false,
        }
    );
}

#[test]
fn timing_values_accept_exact_boundaries_and_reject_invalid_values() {
    let timeout = parsed(&["talk", "peer", "hello", "--timeout", "86400s"]);
    assert_eq!(
        timeout.invocation,
        Invocation::Talk {
            target: "peer".into(),
            message: "hello".into(),
            originator: None,
            options: TalkOptions {
                force: false,
                detach: false,
                delay_seconds: None,
                timeout_seconds: Some(86_400.0),
                no_preamble: false,
            },
        }
    );
    let delay = parsed(&["talk", "peer", "hello", "--delay", "2147483647ms"]);
    assert_eq!(
        delay.invocation,
        Invocation::Talk {
            target: "peer".into(),
            message: "hello".into(),
            originator: None,
            options: TalkOptions {
                force: false,
                detach: false,
                delay_seconds: Some(2_147_483.647),
                timeout_seconds: None,
                no_preamble: false,
            },
        }
    );

    for (argv, text) in [
        (
            &["talk", "peer", "hello", "--timeout", "86400.001s"][..],
            "24 hours",
        ),
        (
            &["talk", "peer", "hello", "--delay", "2147483648ms"][..],
            "timer limit",
        ),
        (
            &["talk", "peer", "hello", "--timeout", "-1"][..],
            "Invalid time format",
        ),
        (
            &["talk", "peer", "hello", "--timeout", "NaN"][..],
            "Invalid time format",
        ),
    ] {
        assert_usage_error(argv, text, OutputMode::default());
    }

    let detached = parsed(&["talk", "peer", "hello", "--detach"]);
    assert_eq!(
        detached.invocation,
        Invocation::Talk {
            target: "peer".into(),
            message: "hello".into(),
            originator: None,
            options: TalkOptions {
                force: false,
                detach: true,
                delay_seconds: None,
                timeout_seconds: None,
                no_preamble: false,
            },
        }
    );
    assert_usage_error(
        &["talk", "peer", "hello", "--detach", "--timeout", "1s"],
        "either --timeout or --detach",
        OutputMode::default(),
    );
}

#[test]
fn capture_and_exchange_integers_accept_exact_boundaries() {
    assert_eq!(
        parsed(&["check", "peer", "0"]).invocation,
        Invocation::Check {
            target: "peer".into(),
            lines: Some(0),
        }
    );
    assert_eq!(
        parsed(&["check", "peer", "--lines", "2147483647"]).invocation,
        Invocation::Check {
            target: "peer".into(),
            lines: Some(2_147_483_647),
        }
    );
    assert_eq!(
        parsed(&["x", "list", "--limit", "200", "--after", "9007199254740991"]).invocation,
        Invocation::Exchange {
            identity: None,
            operation: ExchangeOperation::List {
                limit: Some(200),
                after: Some(9_007_199_254_740_991),
            },
        }
    );
    assert_eq!(
        parsed(&["x", "ack", "request-1", "--revision", "9007199254740991"]).invocation,
        Invocation::Exchange {
            identity: None,
            operation: ExchangeOperation::Ack {
                request_id: "request-1".into(),
                revision: 9_007_199_254_740_991,
            },
        }
    );

    for argv in [
        &["check", "peer", "2147483648"][..],
        &["check", "peer", "--lines", "2147483648"][..],
        &["check", "peer", "--lines", "1.5"][..],
        &["check", "peer", "--lines", "-1"][..],
        &["x", "list", "--after", "9007199254740992"][..],
        &["x", "ack", "request-1", "--revision", "0"][..],
    ] {
        assert_eq!(parse_error(argv).code, "USAGE_ERROR", "arguments: {argv:?}");
    }
}

#[test]
fn input_sources_are_mutually_exclusive_and_required() {
    assert_eq!(
        parsed(&["reply", "request-1", "--receipt", "receipt", "--stdin",]).invocation,
        Invocation::Reply {
            request_id: "request-1".into(),
            receipt: "receipt".into(),
            input: ContentInput::Stdin,
        }
    );
    assert_eq!(
        parsed(&["role", "set", "profile text", "--identity", "Alice",]).invocation,
        Invocation::Role {
            identity: Some("Alice".into()),
            operation: RoleOperation::Set(ContentInput::Inline("profile text".into())),
        }
    );

    for (argv, text) in [
        (
            &["reply", "request-1", "--receipt", "receipt"][..],
            "exactly one inline content",
        ),
        (
            &[
                "reply",
                "request-1",
                "--receipt",
                "receipt",
                "--message",
                "inline",
                "--file",
                "/tmp/response.txt",
            ][..],
            "exactly one inline content",
        ),
        (
            &["role", "set", "inline", "--file", "/tmp/profile.txt"][..],
            "exactly one inline content",
        ),
    ] {
        assert_usage_error(argv, text, OutputMode::default());
    }
}

#[test]
fn nested_exchange_and_role_options_stay_at_their_own_boundaries() {
    assert_eq!(
        parsed(&["x", "--identity", "Alice", "list", "--limit", "2"]).invocation,
        Invocation::Exchange {
            identity: Some("Alice".into()),
            operation: ExchangeOperation::List {
                limit: Some(2),
                after: None,
            },
        }
    );
    assert_eq!(
        parsed(&["x", "list", "--identity", "Alice", "--after", "0"]).invocation,
        Invocation::Exchange {
            identity: Some("Alice".into()),
            operation: ExchangeOperation::List {
                limit: None,
                after: Some(0),
            },
        }
    );
    assert_eq!(
        parsed(&["role", "--identity", "Alice", "show"]).invocation,
        Invocation::Role {
            identity: Some("Alice".into()),
            operation: RoleOperation::Show,
        }
    );
    assert_eq!(
        parsed(&["role", "show", "--identity", "Alice"]).invocation,
        Invocation::Role {
            identity: Some("Alice".into()),
            operation: RoleOperation::Show,
        }
    );

    for (argv, text) in [
        (
            &["x", "list", "--force"][..],
            "Unknown option or argument 'force'",
        ),
        (
            &["role", "show", "--limit", "2"][..],
            "unexpected argument '--limit'",
        ),
        (
            &["role", "show", "--file", "/tmp/profile.txt"][..],
            "unexpected argument '--file'",
        ),
    ] {
        assert_usage_error(argv, text, OutputMode::default());
    }
}
