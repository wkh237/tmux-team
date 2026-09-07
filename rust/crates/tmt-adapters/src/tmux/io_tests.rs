use super::*;
use crate::process::CommandOutput;
use std::{cell::RefCell, collections::VecDeque, io};

const SERVER_ID: &str = "123e4567-e89b-42d3-a456-426614174000";

#[derive(Debug)]
struct Invocation {
    program: String,
    args: Vec<String>,
    deadline: Instant,
    max_output_bytes: usize,
}

#[derive(Default)]
struct ScriptedRunner {
    results: RefCell<VecDeque<Result<CommandOutput, CommandError>>>,
    calls: RefCell<Vec<Invocation>>,
}

impl ScriptedRunner {
    fn new(results: impl IntoIterator<Item = Result<&'static str, CommandError>>) -> Self {
        Self {
            results: RefCell::new(
                results
                    .into_iter()
                    .map(|result| {
                        result.map(|text| CommandOutput {
                            stdout: text.as_bytes().to_vec(),
                            stderr: Vec::new(),
                        })
                    })
                    .collect(),
            ),
            ..Self::default()
        }
    }
}

impl CommandRunner for ScriptedRunner {
    fn execute(&self, request: CommandRequest<'_>) -> Result<CommandOutput, CommandError> {
        assert!(request.input.is_empty());
        self.calls.borrow_mut().push(Invocation {
            program: request.program.to_str().unwrap().into(),
            args: request
                .args
                .iter()
                .map(|value| value.to_str().unwrap().into())
                .collect(),
            deadline: request.deadline,
            max_output_bytes: request.max_output_bytes,
        });
        self.results
            .borrow_mut()
            .pop_front()
            .expect("unexpected extra subprocess")
    }
}

fn failure(cleanup_failed: bool) -> CommandError {
    let mut error = CommandError::new(CommandFailure::Timeout);
    if cleanup_failed {
        error.cleanup_error = Some(io::Error::from_raw_os_error(Errno::EPERM as i32));
    }
    error
}

fn full_environment() -> CallerEnvironment {
    CallerEnvironment {
        tmux: Some("/tmp/private.sock,321,0".into()),
        pane: Some("%9".into()),
        process_id: 900,
    }
}

#[test]
fn complete_caller_evidence_uses_one_small_query_without_ancestry() {
    let tmux = Tmux::new(ScriptedRunner::new([Ok(
        "%9__TMT_CALLER_PANE_4f1c__/tmp/private.sock__TMT_CALLER_PANE_4f1c__321\n",
    )]));
    assert_eq!(
        tmux.caller_pane(&full_environment()).unwrap().as_deref(),
        Some("%9")
    );
    let calls = tmux.runner.calls.borrow();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].program, "tmux");
    assert_eq!(&calls[0].args[..4], ["display-message", "-p", "-t", "%9"]);
    assert_eq!(calls[0].max_output_bytes, 4096);
}

#[test]
fn malformed_explicit_environment_and_scopes_never_spawn() {
    let tmux = Tmux::new(ScriptedRunner::default());
    for (context, pane) in [("bad", "%9"), ("/tmp/private.sock,321,0", "main:0.0")] {
        let environment = CallerEnvironment {
            tmux: Some(context.into()),
            pane: Some(pane.into()),
            process_id: 900,
        };
        assert_eq!(tmux.caller_pane(&environment).unwrap(), None);
    }
    let panes = vec!["%9".into(), "#{pane_id}".into()];
    let error = tmux
        .snapshot(OperationOptions {
            pane_ids: Some(&panes),
            ..Default::default()
        })
        .unwrap_err();
    assert_eq!(error.kind, TmuxFailure::Evidence);
    assert!(tmux.runner.calls.borrow().is_empty());
}

#[test]
fn ancestry_and_snapshot_share_one_deadline_and_reject_ambient_panes() {
    let tmux = Tmux::new(ScriptedRunner::new([
        Ok("900 700\n"),
        Ok("700 0\n"),
        Ok(
            "%9__TMT_CALLER_PANE_4f1c__800__TMT_CALLER_PANE_4f1c__/tmp/private.sock__TMT_CALLER_PANE_4f1c__321\n",
        ),
    ]));
    let environment = CallerEnvironment {
        tmux: None,
        pane: None,
        process_id: 900,
    };
    assert_eq!(tmux.caller_pane(&environment).unwrap(), None);
    let calls = tmux.runner.calls.borrow();
    assert_eq!(calls.len(), 3);
    assert_eq!(calls[0].program, "ps");
    assert_eq!(calls[0].args, ["-o", "pid=,ppid=", "-p", "900"]);
    assert_eq!(calls[1].args, ["-o", "pid=,ppid=", "-p", "700"]);
    assert_eq!(calls[2].program, "tmux");
    assert!(calls.iter().all(|call| call.deadline == calls[0].deadline));
    assert!(calls.iter().all(|call| call.max_output_bytes == 64 * 1024));
}

#[test]
fn unavailable_observations_do_not_hide_failed_cleanup() {
    for failed_cleanup in [false, true] {
        let tmux = Tmux::new(ScriptedRunner::new([Err(failure(failed_cleanup))]));
        let caller = tmux.caller_pane(&full_environment());
        if failed_cleanup {
            assert!(caller.unwrap_err().cleanup_failed());
        } else {
            assert_eq!(caller.unwrap(), None);
        }

        let tmux = Tmux::new(ScriptedRunner::new([Err(failure(failed_cleanup))]));
        let target = tmux.resolve_target("10.3", OperationOptions::default());
        if failed_cleanup {
            assert!(target.unwrap_err().cleanup_failed());
        } else {
            assert_eq!(target.unwrap(), None);
        }

        let tmux = Tmux::new(ScriptedRunner::new([Err(failure(failed_cleanup))]));
        let probe = tmux.probe(
            "/tmp/private.sock",
            u64::from(std::process::id()),
            OperationOptions::default(),
        );
        if failed_cleanup {
            assert!(probe.unwrap_err().cleanup_failed());
        } else {
            assert!(matches!(probe.unwrap(), EndpointProbe::Unknown));
        }
    }
}

#[test]
fn ancestry_requires_one_coherent_candidate_after_grouped_row_deduplication() {
    const MATCH: &str = "%9__TMT_CALLER_PANE_4f1c__700__TMT_CALLER_PANE_4f1c__/tmp/private.sock__TMT_CALLER_PANE_4f1c__321";
    const OTHER: &str = "%10__TMT_CALLER_PANE_4f1c__900__TMT_CALLER_PANE_4f1c__/tmp/private.sock__TMT_CALLER_PANE_4f1c__321";
    for (rows, expected) in [
        (format!("{MATCH}\n{MATCH}\n"), Some("%9")),
        (format!("{MATCH}\n{OTHER}\n"), None),
        (format!("{MATCH}\n{}\n", MATCH.replace("700", "800")), None),
        (format!("{}\n{MATCH}\n", MATCH.replace("700", "800")), None),
    ] {
        let runner = ScriptedRunner::new([Ok("900 700\n"), Ok("700 0\n")]);
        runner.results.borrow_mut().push_back(Ok(CommandOutput {
            stdout: rows.into_bytes(),
            stderr: Vec::new(),
        }));
        let tmux = Tmux::new(runner);
        let environment = CallerEnvironment {
            tmux: None,
            pane: None,
            process_id: 900,
        };
        assert_eq!(tmux.caller_pane(&environment).unwrap().as_deref(), expected);
        assert_eq!(tmux.runner.calls.borrow().len(), 3);
    }
}

#[test]
fn partial_caller_evidence_cannot_override_explicit_socket_or_pane() {
    for environment in [
        CallerEnvironment {
            tmux: Some("/different.sock,321,0".into()),
            pane: None,
            process_id: 900,
        },
        CallerEnvironment {
            tmux: None,
            pane: Some("%10".into()),
            process_id: 900,
        },
    ] {
        let tmux = Tmux::new(ScriptedRunner::new([
            Ok("900 700\n"),
            Ok("700 0\n"),
            Ok(
                "%9__TMT_CALLER_PANE_4f1c__700__TMT_CALLER_PANE_4f1c__/tmp/private.sock__TMT_CALLER_PANE_4f1c__321\n",
            ),
        ]));
        assert_eq!(tmux.caller_pane(&environment).unwrap(), None);
        let calls = tmux.runner.calls.borrow();
        assert_eq!(calls.len(), 3);
        if environment.tmux.is_some() {
            assert_eq!(&calls[2].args[..2], ["-S", "/different.sock"]);
        }
    }
}

#[test]
fn ancestry_cycle_stops_before_any_pane_query() {
    let tmux = Tmux::new(ScriptedRunner::new([Ok("900 700\n"), Ok("700 900\n")]));
    let environment = CallerEnvironment {
        tmux: None,
        pane: None,
        process_id: 900,
    };
    assert_eq!(tmux.caller_pane(&environment).unwrap(), None);
    assert!(
        tmux.runner
            .calls
            .borrow()
            .iter()
            .all(|call| call.program == "ps")
    );
}

#[test]
fn server_initialization_stops_after_cleanup_failure() {
    let tmux = Tmux::new(ScriptedRunner::new([Err(failure(true))]));
    assert!(
        tmux.snapshot(OperationOptions::default())
            .unwrap_err()
            .cleanup_failed()
    );
    assert_eq!(
        tmux.runner.calls.borrow().len(),
        1,
        "failed cleanup cannot trigger a metadata mutation"
    );
}

#[test]
fn expired_operation_budget_prevents_even_the_first_query() {
    let tmux = Tmux::new(ScriptedRunner::default());
    let error = tmux
        .snapshot(OperationOptions {
            deadline: Some(Instant::now()),
            pane_ids: None,
        })
        .unwrap_err();
    assert_eq!(error.cause.unwrap().kind, CommandFailure::Timeout);
    assert!(tmux.runner.calls.borrow().is_empty());
}

#[test]
fn failed_metadata_read_never_authorizes_a_write() {
    let tmux = Tmux::new(ScriptedRunner::new([Err(failure(false))]));
    let error = tmux
        .clear_marker("%9", None, OperationOptions::default())
        .unwrap_err();
    assert_eq!(error.kind, TmuxFailure::MetadataRead);
    assert_eq!(
        error.to_string(),
        "Could not read pane metadata (ETIMEDOUT)."
    );
    assert_eq!(tmux.runner.calls.borrow().len(), 1);
}

#[test]
fn nonmatching_clear_preserves_metadata_without_a_write() {
    let tmux = Tmux::new(ScriptedRunner::new([Ok(
        r#"{"version":1,"globalIdentity":{"bindingId":"other"},"opaque":true}"#,
    )]));
    assert!(
        !tmux
            .clear_marker("%9", Some("mine"), OperationOptions::default())
            .unwrap()
    );
    assert_eq!(tmux.runner.calls.borrow().len(), 1);
}

#[test]
fn empty_scope_reads_server_only_and_never_enumerates_panes() {
    let tmux = Tmux::new(ScriptedRunner::new([
        Ok(SERVER_ID),
        Ok(
            "123e4567-e89b-42d3-a456-426614174000__TMT_FIELD_4f1c__/tmp/private.sock__TMT_FIELD_4f1c__321__TMT_FIELD_4f1c__1700000000\n",
        ),
    ]));
    let snapshot = tmux
        .snapshot(OperationOptions {
            pane_ids: Some(&[]),
            ..Default::default()
        })
        .unwrap();
    assert!(snapshot.panes.is_empty());
    assert_eq!(snapshot.server.server_id, SERVER_ID);
    let calls = tmux.runner.calls.borrow();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[1].args[0], "display-message");
    assert!(
        calls
            .iter()
            .all(|call| !call.args.iter().any(|arg| arg == "list-panes"))
    );
}
