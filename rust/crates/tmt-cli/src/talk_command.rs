//! Native talk composition over existing request, identity and transport owners.

mod observation;
mod preparation;
mod presentation;

use crate::{
    invocation::{Invocation, OutputMode, TalkOptions},
    output::{Failure, after_cleanup},
};
use std::{
    io,
    time::{Duration, Instant},
};
use tmt_adapters::{
    config::{ConfigFiles, ConfigPaths},
    interrupt::Interrupt,
    request_runtime::wall_time_ms,
    storage::{Storage, StorageError},
    tmux::Tmux,
};
use tmt_core::{
    exact_text::validate_exact_text,
    identity::Identity,
    request::{FinalResponse, RequestEndpoint, RequestError, RequestService, Settlement},
    settings::Settings,
};

struct Input {
    target: String,
    message: String,
    originator: Option<String>,
    options: TalkOptions,
}
#[derive(Clone)]
struct Correlation {
    request_id: String,
    target: String,
    pane: String,
    identity: Option<Identity>,
}
struct Prepared {
    correlation: Correlation,
    attempt_id: String,
    endpoint: RequestEndpoint,
    payload: String,
    previous_request_id: Option<String>,
}
struct Report {
    correlation: Correlation,
    response: Option<FinalResponse>,
}

impl Correlation {
    fn error(&self, code: &'static str, message: impl Into<String>, status: u8) -> Failure {
        Failure::new(code, message, status)
            .with_request(self.request_id.clone(), None)
            .with_target(&self.target, &self.pane, self.identity.as_ref())
    }
    fn inspection(&self) -> String {
        format!(
            "Inspect with 'tmt result {}' and 'tmt check {}' before deciding whether to retry.",
            self.request_id, self.target
        )
    }
    fn state_error(&self, error: RequestError<StorageError>, possible_delivery: bool) -> Failure {
        self.error(
            "REQUEST_STATE_ERROR",
            if possible_delivery {
                "Request state failed after transport; delivery may have occurred."
            } else {
                "Request state failed before transport; no message was sent."
            },
            1,
        )
        .suggestion(self.inspection())
        .caused_by(error)
    }
    fn interrupted(&self) -> Failure {
        self.error(
            "INTERRUPTED",
            "Interrupted while waiting for a durable reply.",
            1,
        )
        .suggestion(self.inspection())
    }
}

fn deliver(
    storage: &mut Storage,
    tmux: &Tmux,
    prepared: &Prepared,
    input: &Input,
    settings: &Settings,
    interrupt: Option<&Interrupt>,
) -> Result<Option<FinalResponse>, Failure> {
    let correlation = &prepared.correlation;
    let mut service = RequestService::new(storage, wall_time_ms);
    let wait = !input.options.detach;
    let timeout = input.options.timeout_seconds.unwrap_or(settings.timeout);
    let deadline = Instant::now() + Duration::from_secs_f64(timeout);
    let pending = (|| {
        if interrupt.is_some_and(Interrupt::is_interrupted) {
            service
                .settle(&prepared.attempt_id, Settlement::DefinitelyFailed)
                .map_err(|error| correlation.state_error(error, false))?;
            return Err(correlation.interrupted());
        }
        if let Err(primary) = service.begin_send(&prepared.attempt_id) {
            // Settlement is idempotent; the primary failure remains diagnostic.
            let primary = correlation.state_error(primary, false);
            return Err(
                match service.settle(&prepared.attempt_id, Settlement::DefinitelyFailed) {
                    Ok(()) => primary,
                    Err(secondary) => primary.with_secondary_error(secondary),
                },
            );
        }
        let delivered = tmux.send_on(
            &prepared.endpoint.server.socket_path,
            &prepared.endpoint.pane_id,
            &prepared.payload,
            Duration::from_secs_f64(settings.paste_enter_delay_ms / 1000.0),
        );
        match delivered {
            Ok(()) => service
                .settle(&prepared.attempt_id, Settlement::Sent)
                .map_err(|error| correlation.state_error(error, true))?,
            Err(error) => {
                let uncertain = error.uncertain();
                if let Err(state) = service.settle(
                    &prepared.attempt_id,
                    if uncertain {
                        Settlement::Uncertain
                    } else {
                        Settlement::DefinitelyFailed
                    },
                ) {
                    return Err(correlation
                        .state_error(state, uncertain)
                        .with_secondary_error(error));
                }
                return Err(correlation
                    .error(
                        if uncertain {
                            "DELIVERY_UNCERTAIN"
                        } else {
                            "DELIVERY_PREPARATION_FAILED"
                        },
                        error.to_string(),
                        1,
                    )
                    .at_stage(error.stage.as_str())
                    .suggestion(correlation.inspection())
                    .caused_by(error));
            }
        }
        if !wait {
            return Ok(None);
        }
        observation::observe(
            || {
                service
                    .get_response(&correlation.request_id)
                    .map_err(|error| correlation.state_error(error, true))
            },
            correlation,
            deadline,
            timeout,
            settings.poll_interval,
            interrupt.expect("wait owns interrupt guard"),
        )
        .map(Some)
    })();
    let released = if wait {
        service
            .release_wait(&prepared.attempt_id)
            .map_err(|error| correlation.state_error(error, true))
    } else {
        Ok(())
    };
    // Waiter release always runs, including rejected transport and read errors.
    match pending {
        Err(primary) => Err(match released {
            Ok(()) => primary,
            Err(secondary) => primary.with_secondary_error(secondary),
        }),
        Ok(value) => released.map(|()| value),
    }
}

fn run(
    input: Input,
    paths: ConfigPaths,
    settings: Settings,
    interrupt: Option<&Interrupt>,
    mode: OutputMode,
) -> Result<Report, Failure> {
    let mut storage = Storage::open(paths.database).map_err(|error| {
        Failure::new(
            "REQUEST_STATE_ERROR",
            "Could not open request storage; no message was sent.",
            1,
        )
        .caused_by(error)
    })?;
    let tmux = Tmux::default();
    let mut cleanup_correlation = None;
    let pending = preparation::prepare(&mut storage, &tmux, &input, &settings, interrupt).and_then(|prepared| {
        cleanup_correlation = Some(prepared.correlation.clone());
        if !mode.json && !input.options.detach && !input.options.force && let Some(previous) = &prepared.previous_request_id {
            eprintln!("Another recent request exists for '{}' (id: {previous}). Input processing is not serialized; durable results remain associated by request ID.", input.target);
        }
        let response = deliver(&mut storage, &tmux, &prepared, &input, &settings, interrupt);
        let correlation = prepared.correlation;
        response.map(|response| Report { correlation, response })
    });
    after_cleanup(pending, || storage.close()).map_err(|error| {
        if error.code == "CLEANUP_ERROR"
            && let Some(correlation) = cleanup_correlation
        {
            error
                .with_request(correlation.request_id, None)
                .with_target(
                    &correlation.target,
                    &correlation.pane,
                    correlation.identity.as_ref(),
                )
        } else {
            error
        }
    })
}

pub fn execute(request: Invocation, mode: OutputMode) -> io::Result<u8> {
    let Invocation::Talk {
        target,
        message,
        originator,
        options,
    } = request
    else {
        unreachable!("talk dispatch")
    };
    let input = Input {
        target,
        message,
        originator,
        options,
    };
    let preflight: Result<_, Failure> = (|| {
        let paths = ConfigPaths::discover().map_err(Failure::from)?;
        let settings = ConfigFiles {
            paths: paths.clone(),
        }
        .load()
        .map_err(Failure::from)?
        .settings;
        validate_exact_text(input.message.as_bytes()).map_err(|_| {
            Failure::new(
                "REQUEST_INPUT_TOO_LARGE",
                "Original request exceeds the UTF-8 byte limit.",
                1,
            )
        })?;
        Ok((paths, settings))
    })();
    let (paths, settings) = match preflight {
        Ok(value) => value,
        Err(error) => return error.publish(mode),
    };
    // Keep callbacks alive through waiter/storage cleanup and output. A second
    // SIGINT retains emergency termination if synchronous work cannot finish.
    let interrupt = if input.options.detach {
        None
    } else {
        match Interrupt::install() {
            Ok(guard) => Some(guard),
            Err(error) => {
                return Failure::new(
                    "ERROR",
                    "Could not install observer interruption handling.",
                    1,
                )
                .caused_by(error)
                .publish(mode);
            }
        }
    };
    match run(input, paths, settings, interrupt.as_ref(), mode) {
        Ok(report) => presentation::publish(report, mode),
        Err(error) => error.publish(mode),
    }
}
