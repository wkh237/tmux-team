//! Public update orchestration. Network acquisition never holds the install lock.

use super::{
    ActivatedInstallation, InstallReport, InstallRequest, inspect, install_observed, release,
};
use std::{
    fs,
    io::{self, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::Path,
    time::{Duration, Instant},
};
use tmt_core::native_install::{
    Channel, InstalledVersion, UpgradeSelection, plan_version, select_upgrade,
};

pub struct UpgradeRequest<'a> {
    pub executable: &'a Path,
    pub channel: Option<Channel>,
    pub exact: Option<&'a str>,
    pub unpin: bool,
}

#[derive(Debug)]
pub struct UpgradeReport {
    pub installation: InstallReport,
    pub state: InstalledVersion,
    pub skipped_pinned: bool,
}

#[derive(Debug)]
pub struct UpgradeFailure {
    /// Present only when this invocation activated a release before failing.
    pub activated: Option<Box<UpgradeReport>>,
    cause: io::Error,
}

impl std::fmt::Display for UpgradeFailure {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.cause.fmt(output)
    }
}
impl std::error::Error for UpgradeFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.cause)
    }
}
impl From<io::Error> for UpgradeFailure {
    fn from(cause: io::Error) -> Self {
        Self {
            activated: None,
            cause,
        }
    }
}
impl UpgradeFailure {
    pub fn kind(&self) -> io::ErrorKind {
        self.cause.kind()
    }
}

pub fn upgrade(
    request: UpgradeRequest<'_>,
    checkpoint: impl FnMut() -> io::Result<()>,
) -> Result<UpgradeReport, UpgradeFailure> {
    let client = crate::release_http::Https::new();
    upgrade_with(request, checkpoint, |url, accept, limit, deadline| {
        client.get(url, accept, limit, deadline)
    })
}

fn upgrade_with(
    request: UpgradeRequest<'_>,
    mut checkpoint: impl FnMut() -> io::Result<()>,
    get: impl FnMut(&str, &str, usize, Instant) -> io::Result<Vec<u8>>,
) -> Result<UpgradeReport, UpgradeFailure> {
    checkpoint()?;
    let current = inspect(request.executable)?;
    let selection = select_upgrade(
        &current.state,
        request.channel,
        request.exact,
        request.unpin,
    )
    .map_err(io::Error::other)?;
    let UpgradeSelection::Fetch {
        channel,
        exact,
        pin,
    } = selection
    else {
        return Ok(UpgradeReport {
            installation: InstallReport {
                executable: current.executable,
                active_executable: current.active_executable,
                version: current.state.version.to_string(),
                changed: false,
            },
            state: current.state,
            skipped_pinned: true,
        });
    };
    let downloaded = release::download(
        channel,
        exact.as_ref(),
        &current.target,
        Instant::now() + Duration::from_secs(60),
        get,
    )?;
    let plan = plan_version(Some(&current.state), &downloaded.version, channel, pin)
        .map_err(io::Error::other)?;
    checkpoint()?;
    // Only this successful create grants cleanup ownership. Never remove a
    // colliding or abandoned staging directory from another invocation.
    let stage = current
        .prefix
        .join("lib/tmux-team")
        .join(format!(".download-{}", uuid::Uuid::new_v4()));
    fs::DirBuilder::new().mode(0o700).create(&stage)?;
    let archive = stage.join(&downloaded.archive_name);
    let manifest = stage.join("dist-manifest.json");
    let result = (|| {
        for (path, bytes) in [
            (&archive, &downloaded.archive),
            (&manifest, &downloaded.manifest),
        ] {
            let mut file = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(path)?;
            file.write_all(bytes)?;
        }
        install_observed(
            InstallRequest {
                archive: &archive,
                manifest: &manifest,
                prefix: &current.prefix,
                target: &current.target,
                channel,
                pin,
            },
            Some(current.id),
            Some(downloaded.provenance),
            &mut checkpoint,
        )
    })();
    let result = result
        .map(|installation| UpgradeReport {
            installation,
            state: plan.state.clone(),
            skipped_pinned: false,
        })
        .map_err(|cause: io::Error| {
            let activated = cause
                .get_ref()
                .and_then(|error| error.downcast_ref::<ActivatedInstallation>())
                .map(|error| {
                    Box::new(UpgradeReport {
                        installation: error.report.clone(),
                        state: plan.state.clone(),
                        skipped_pinned: false,
                    })
                });
            UpgradeFailure { activated, cause }
        });
    match (result, fs::remove_dir_all(&stage)) {
        (result, Ok(())) => result,
        (Ok(report), Err(cleanup)) => Err(UpgradeFailure {
            activated: report.installation.changed.then(|| Box::new(report)),
            cause: io::Error::new(
                cleanup.kind(),
                format!("Native update staging cleanup failed: {cleanup}"),
            ),
        }),
        (Err(mut failure), Err(cleanup)) => {
            failure.cause = io::Error::new(
                failure.cause.kind(),
                format!(
                    "{}; native update staging cleanup failed: {cleanup}",
                    failure.cause
                ),
            );
            Err(failure)
        }
    }
}

#[cfg(test)]
#[path = "upgrade_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "upgrade_artifact_tests.rs"]
mod artifact_tests;
