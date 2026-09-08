use super::*;
use crate::test_support::TestDirectory;
use nix::{sys::stat::Mode, unistd::mkfifo};
use std::{
    env, fs,
    os::unix::fs::symlink,
    process::{Child, Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};

const FIFO_FIXTURE_TEST: &str = "bounded_file::tests::fifo_fixture";
const FIFO_FIXTURE_PATH: &str = "TMT_BOUNDED_FILE_FIFO";
const FIFO_EXIT_TIMEOUT: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(10);

#[test]
fn bounded_reads_accept_regular_files_and_reject_oversized_content() {
    let directory = TestDirectory::new();
    let file = directory.path.join("body");
    fs::write(&file, b"body").unwrap();

    assert_eq!(read(&file, 4).unwrap(), b"body");
    assert_eq!(read_no_follow(&file, 4).unwrap(), b"body");
    assert!(matches!(read(&file, 3), Err(FileReadError::TooLarge)));
    assert!(matches!(
        read_no_follow(&file, 3),
        Err(FileReadError::TooLarge)
    ));
}

#[test]
fn no_follow_rejects_symlinks_while_read_continues_to_follow_them() {
    let directory = TestDirectory::new();
    let target = directory.path.join("target");
    let link = directory.path.join("link");
    fs::write(&target, b"target bytes").unwrap();
    symlink(&target, &link).unwrap();

    assert_eq!(read(&link, 64).unwrap(), b"target bytes");
    assert!(matches!(
        read_no_follow(&link, 64),
        Err(FileReadError::Io(_))
    ));
    assert_eq!(fs::read(&target).unwrap(), b"target bytes");
    assert_eq!(fs::read_link(&link).unwrap(), target);
}

#[test]
fn no_follow_rejects_directories_without_waiting() {
    let directory = TestDirectory::new();
    assert!(matches!(
        read_no_follow(&directory.path, 64),
        Err(FileReadError::Io(_))
    ));

    let fifo = directory.path.join("fifo");
    mkfifo(&fifo, Mode::S_IRUSR | Mode::S_IWUSR).unwrap();
    let mut fixture = FifoFixture::start(&fifo);
    let status = wait_for_exit(&mut fixture.child, FIFO_EXIT_TIMEOUT);
    assert!(
        status.success(),
        "FIFO fixture rejected input unsuccessfully: {status}"
    );
}

struct FifoFixture {
    child: Child,
}

impl FifoFixture {
    fn start(path: &std::path::Path) -> Self {
        let executable = env::current_exe().expect("locate bounded-file test binary");
        let child = Command::new(executable)
            .args([
                "--exact",
                FIFO_FIXTURE_TEST,
                "--nocapture",
                "--test-threads=1",
            ])
            .env(FIFO_FIXTURE_PATH, path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn task-owned FIFO fixture");
        Self { child }
    }
}

impl Drop for FifoFixture {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn wait_for_exit(child: &mut Child, timeout: Duration) -> ExitStatus {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().expect("inspect FIFO fixture status") {
            return status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let status = child.wait().expect("reap timed-out FIFO fixture");
            panic!("FIFO fixture did not exit before deadline: {status}");
        }
        thread::sleep(POLL_INTERVAL);
    }
}

#[test]
fn fifo_fixture() {
    let Some(path) = env::var_os(FIFO_FIXTURE_PATH) else {
        return;
    };
    let path = std::path::PathBuf::from(path);
    assert!(matches!(
        read_no_follow(&path, 64),
        Err(FileReadError::Io(_))
    ));
}
