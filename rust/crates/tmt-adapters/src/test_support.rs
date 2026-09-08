use std::{
    fs,
    path::Path,
    path::PathBuf,
    process::{Child, ExitStatus},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant},
};

/// One invocation-owned filesystem fixture shared by native adapter tests.
pub(crate) struct TestDirectory {
    pub path: PathBuf,
}

impl TestDirectory {
    pub fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "tmt-native-adapter-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        // Refuse to reuse an existing directory; cleanup owns only this creation.
        fs::create_dir(&path).expect("create unique adapter test directory");
        Self { path }
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.path) {
            if std::thread::panicking() {
                eprintln!(
                    "Could not remove adapter fixture {}: {error}",
                    self.path.display()
                );
            } else {
                panic!(
                    "Could not remove adapter fixture {}: {error}",
                    self.path.display()
                );
            }
        }
    }
}

/// Owns a task-local child process and guarantees bounded cleanup on every test path.
///
/// `try_wait` marks the child as reaped before returning its status. Drop therefore
/// never signals a child after observing that it has exited, avoiding a recycled-PID
/// signal while still killing and reaping a live child after a panic or timeout.
pub(crate) struct TestChild {
    pub child: Child,
}

impl TestChild {
    pub(crate) fn new(child: Child) -> Self {
        Self { child }
    }

    pub(crate) fn wait_for_content(&mut self, path: &Path, expected: &str, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        loop {
            if fs::read_to_string(path).ok().as_deref() == Some(expected) {
                return;
            }
            if let Some(status) = self
                .child
                .try_wait()
                .expect("inspect task-owned test child status")
            {
                panic!("test child exited before {}: {status}", path.display());
            }
            assert!(
                Instant::now() < deadline,
                "test child did not publish {expected:?} to {}",
                path.display(),
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    pub(crate) fn wait_for_exit(&mut self, timeout: Duration) -> ExitStatus {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self
                .child
                .try_wait()
                .expect("inspect task-owned test child status")
            {
                return status;
            }
            if Instant::now() >= deadline {
                let _ = self.child.kill();
                let status = self.child.wait().expect("reap timed-out test child");
                panic!("test child did not exit before deadline: {status}");
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for TestChild {
    fn drop(&mut self) {
        match self.child.try_wait() {
            Ok(Some(_)) | Err(_) => {}
            Ok(None) => {
                let _ = self.child.kill();
                let _ = self.child.wait();
            }
        }
    }
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use nix::{
        errno::Errno,
        sys::wait::{WaitPidFlag, WaitStatus, waitpid},
        unistd::Pid,
    };
    use std::{
        panic::{AssertUnwindSafe, catch_unwind},
        process::{Command, Stdio},
    };

    const READY_ENV: &str = "TMT_TEST_CHILD_READY";
    const MARKER_ENV: &str = "TMT_TEST_CHILD_MARKER";
    const RELEASE_ENV: &str = "TMT_TEST_CHILD_RELEASE";
    const CHILD_TEST: &str = "test_support::tests::cleanup_child_process";
    const CHILD_START_TIMEOUT: Duration = Duration::from_secs(2);

    #[test]
    fn cleanup_child_process() {
        let Some(ready) = std::env::var_os(READY_ENV) else {
            return;
        };
        let marker = std::env::var_os(MARKER_ENV).expect("cleanup marker environment");
        let release = PathBuf::from(std::env::var_os(RELEASE_ENV).expect("cleanup release path"));
        fs::write(ready, "ready").expect("publish cleanup child readiness");
        let deadline = Instant::now() + Duration::from_secs(10);
        while !release.exists() {
            assert!(
                Instant::now() < deadline,
                "parent did not release or stop cleanup child"
            );
            thread::sleep(Duration::from_millis(10));
        }
        fs::write(marker, "survived").expect("publish cleanup child marker");
    }

    fn spawn_cleanup_child(directory: &TestDirectory) -> TestChild {
        let ready = directory.path.join("ready");
        let marker = directory.path.join("marker");
        let child = Command::new(std::env::current_exe().expect("locate test executable"))
            .args(["--exact", CHILD_TEST, "--nocapture"])
            .env(READY_ENV, &ready)
            .env(MARKER_ENV, &marker)
            .env(RELEASE_ENV, directory.path.join("release"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn cleanup child");
        let mut child = TestChild::new(child);
        child.wait_for_content(&ready, "ready", CHILD_START_TIMEOUT);
        child
    }

    fn assert_reaped(pid: u32) {
        match waitpid(
            Pid::from_raw(i32::try_from(pid).expect("child PID fits in pid_t")),
            Some(WaitPidFlag::WNOHANG),
        ) {
            Err(Errno::ECHILD) => {}
            Ok(WaitStatus::StillAlive) => panic!("test child {pid} was not reaped"),
            Ok(status) => panic!("unexpected status for test child {pid}: {status:?}"),
            Err(error) => panic!("inspect test child {pid}: {error}"),
        }
    }

    fn assert_marker_absent(directory: &TestDirectory) {
        assert!(!directory.path.join("marker").exists());
    }

    #[test]
    fn drop_reaps_a_live_child_during_panic_unwind() {
        let directory = TestDirectory::new();
        let mut child = Some(spawn_cleanup_child(&directory));
        let pid = child.as_ref().expect("cleanup child").child.id();
        let started = Instant::now();
        let result = catch_unwind(AssertUnwindSafe(|| {
            let _child = child.take().expect("take cleanup child");
            panic!("force cleanup during panic unwind");
        }));
        assert!(result.is_err());
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "cleanup waited for the child's fallback deadline"
        );
        assert_reaped(pid);
        assert_marker_absent(&directory);
    }

    #[test]
    fn timeout_reaps_a_live_child_before_panicking() {
        let directory = TestDirectory::new();
        let mut pid = None;
        let started = Instant::now();
        let result = catch_unwind(AssertUnwindSafe(|| {
            let mut child = spawn_cleanup_child(&directory);
            pid = Some(child.child.id());
            let _ = child.wait_for_exit(Duration::from_millis(20));
        }));
        assert!(result.is_err());
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "timeout did not stop its child promptly"
        );
        assert_reaped(pid.expect("cleanup child PID"));
        assert_marker_absent(&directory);
    }

    #[test]
    fn drop_does_not_signal_a_child_after_normal_exit() {
        let directory = TestDirectory::new();
        let mut child = spawn_cleanup_child(&directory);
        let pid = child.child.id();
        fs::write(directory.path.join("release"), "finish").unwrap();
        let status = child.wait_for_exit(Duration::from_secs(2));
        assert!(status.success());
        assert_eq!(
            fs::read_to_string(directory.path.join("marker")).expect("normal-exit marker"),
            "survived"
        );
        drop(child);
        assert_reaped(pid);
    }
}
