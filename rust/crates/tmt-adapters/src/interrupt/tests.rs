use super::Interrupt;
use crate::test_support::TestDirectory;
use nix::{
    sys::signal::{Signal, kill},
    unistd::Pid,
};
use std::{
    env, fs,
    os::unix::process::ExitStatusExt,
    path::Path,
    process::{Child, Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};

const FIXTURE_TEST: &str = "interrupt::tests::subprocess_fixture";
const FIXTURE_MODE: &str = "TMT_INTERRUPT_TEST_MODE";
const FIXTURE_READY: &str = "TMT_INTERRUPT_TEST_READY";
const FIXTURE_EVENT: &str = "TMT_INTERRUPT_TEST_EVENT";
const POLL_INTERVAL: Duration = Duration::from_millis(10);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(2);
const EXIT_TIMEOUT: Duration = Duration::from_secs(3);

struct Fixture {
    _directory: TestDirectory,
    ready: std::path::PathBuf,
    event: std::path::PathBuf,
    child: Child,
}

impl Fixture {
    fn start(mode: &str) -> Self {
        let directory = TestDirectory::new();
        let ready = directory.path.join("ready");
        let event = directory.path.join("event");
        let executable = env::current_exe().expect("locate adapter test executable");
        let child = Command::new(executable)
            .args(["--exact", FIXTURE_TEST, "--nocapture", "--test-threads=1"])
            .env(FIXTURE_MODE, mode)
            .env(FIXTURE_READY, &ready)
            .env(FIXTURE_EVENT, &event)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn task-owned interrupt fixture");
        Self {
            _directory: directory,
            ready,
            event,
            child,
        }
    }

    fn wait_for_content(&mut self, path: &Path, expected: &str, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        loop {
            if fs::read_to_string(path).ok().as_deref() == Some(expected) {
                return;
            }
            if let Some(status) = self
                .child
                .try_wait()
                .expect("inspect interrupt fixture status")
            {
                panic!(
                    "interrupt fixture exited before {}: {status}",
                    path.display()
                );
            }
            assert!(
                Instant::now() < deadline,
                "interrupt fixture did not publish {expected:?} to {}",
                path.display(),
            );
            thread::sleep(POLL_INTERVAL);
        }
    }

    fn wait_for_exit(&mut self, timeout: Duration) -> ExitStatus {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self
                .child
                .try_wait()
                .expect("inspect interrupt fixture status")
            {
                return status;
            }
            assert!(Instant::now() < deadline, "interrupt fixture did not exit");
            thread::sleep(POLL_INTERVAL);
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn fixture_pid(fixture: &Fixture) -> Pid {
    Pid::from_raw(i32::try_from(fixture.child.id()).expect("fixture PID fits in pid_t"))
}

fn event(fixture: &Fixture) -> String {
    fs::read_to_string(&fixture.event).expect("interrupt fixture wrote its event")
}

fn open_fd_count() -> usize {
    fs::read_dir("/dev/fd")
        .expect("the Unix test host exposes /dev/fd")
        .count()
}

#[test]
fn sigint_wakes_a_task_owned_wait() {
    let mut fixture = Fixture::start("wake");
    fixture.wait_for_content(&fixture.ready.clone(), "ready", STARTUP_TIMEOUT);
    kill(fixture_pid(&fixture), Signal::SIGINT).expect("send SIGINT to fixture child");

    let status = fixture.wait_for_exit(EXIT_TIMEOUT);
    assert!(status.success(), "fixture failed after SIGINT: {status}");
    assert_eq!(event(&fixture), "interrupted");
}

#[test]
fn second_sigint_uses_the_emergency_default() {
    let mut fixture = Fixture::start("second");
    fixture.wait_for_content(&fixture.ready.clone(), "ready", STARTUP_TIMEOUT);
    kill(fixture_pid(&fixture), Signal::SIGINT).expect("send first SIGINT to fixture child");
    fixture.wait_for_content(&fixture.event.clone(), "first-interrupted", STARTUP_TIMEOUT);
    assert_eq!(event(&fixture), "first-interrupted");

    kill(fixture_pid(&fixture), Signal::SIGINT).expect("send second SIGINT to fixture child");
    let status = fixture.wait_for_exit(EXIT_TIMEOUT);
    assert_eq!(
        status.signal(),
        Some(Signal::SIGINT as i32),
        "second SIGINT must terminate the fixture"
    );
}

#[test]
fn deadline_returns_without_a_signal() {
    let mut fixture = Fixture::start("deadline");
    fixture.wait_for_content(&fixture.ready.clone(), "ready", STARTUP_TIMEOUT);

    let status = fixture.wait_for_exit(EXIT_TIMEOUT);
    assert!(status.success(), "deadline fixture failed: {status}");
    assert_eq!(event(&fixture), "deadline-no-signal");
}

#[test]
fn guard_drop_releases_descriptors_and_allows_reinstallation() {
    let mut fixture = Fixture::start("drop");
    fixture.wait_for_content(&fixture.ready.clone(), "ready", STARTUP_TIMEOUT);

    let status = fixture.wait_for_exit(EXIT_TIMEOUT);
    assert!(status.success(), "drop fixture failed: {status}");
    assert_eq!(event(&fixture), "reinstalled");
}

#[test]
fn subprocess_fixture() {
    let Some(mode) = env::var_os(FIXTURE_MODE) else {
        return;
    };
    let ready = env::var_os(FIXTURE_READY)
        .map(std::path::PathBuf::from)
        .expect("fixture ready path");
    let event = env::var_os(FIXTURE_EVENT)
        .map(std::path::PathBuf::from)
        .expect("fixture event path");
    let mode = mode.to_str().expect("fixture mode is UTF-8");
    let interrupt = Interrupt::install().expect("install interrupt fixture");
    fs::write(&ready, b"ready").expect("publish interrupt fixture readiness");

    match mode {
        "wake" => {
            interrupt
                .wait_until(Instant::now() + Duration::from_secs(5))
                .expect("SIGINT wait should not fail");
            assert!(interrupt.is_interrupted());
            fs::write(event, b"interrupted").expect("publish interrupt event");
        }
        "second" => {
            interrupt
                .wait_until(Instant::now() + Duration::from_secs(5))
                .expect("first SIGINT wait should not fail");
            assert!(interrupt.is_interrupted());
            fs::write(event, b"first-interrupted").expect("publish first interrupt event");
            thread::sleep(Duration::from_secs(30));
        }
        "deadline" => {
            let deadline = Instant::now() + Duration::from_millis(200);
            interrupt
                .wait_until(deadline)
                .expect("deadline wait should not fail");
            assert!(
                Instant::now() >= deadline,
                "wait returned before its deadline"
            );
            assert!(!interrupt.is_interrupted());
            fs::write(event, b"deadline-no-signal").expect("publish deadline event");
        }
        "drop" => {
            let original_interrupted = interrupt.interrupted.clone();
            let with_guard = open_fd_count();
            assert!(with_guard >= 2, "interrupt guard descriptors are present");
            drop(interrupt);
            assert_eq!(
                open_fd_count(),
                with_guard - 2,
                "guard drop closes both interrupt descriptors"
            );

            let replacement = Interrupt::install().expect("reinstall interrupt after drop");
            assert_eq!(
                open_fd_count(),
                with_guard,
                "reinstallation restores the interrupt descriptors"
            );
            kill(Pid::this(), Signal::SIGINT).expect("signal task-owned fixture process");
            replacement
                .wait_until(Instant::now() + Duration::from_secs(2))
                .expect("reinstalled interrupt should wake");
            assert!(replacement.is_interrupted());
            assert!(!original_interrupted.load(std::sync::atomic::Ordering::SeqCst));
            fs::write(event, b"reinstalled").expect("publish reinstall event");
        }
        _ => panic!("unknown interrupt fixture mode: {mode}"),
    }
}
