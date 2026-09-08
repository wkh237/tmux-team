//! Verified native release acquisition and managed publication, without app state.

mod artifact;
mod managed;
pub use managed::{ManagedInstallation, inspect, with_active_release};
#[cfg(test)]
mod artifact_tests;
#[cfg(test)]
mod interrupt_tests;
mod publication;
#[cfg(test)]
mod publication_tests;
mod receipt;
mod release;
mod upgrade;
pub use upgrade::{UpgradeFailure, UpgradeReport, UpgradeRequest, upgrade};
#[cfg(test)]
mod test_support;

use std::{
    io,
    path::{Path, PathBuf},
};
use tmt_core::native_install::{Channel, PinAction, plan_version};

const OFFICIAL_REPOSITORY: &str = "wkh237/tmux-team";

#[derive(Debug, Clone)]
pub struct InstallReport {
    pub executable: PathBuf,
    pub active_executable: PathBuf,
    pub version: String,
    pub changed: bool,
}

#[derive(Debug)]
struct ActivatedInstallation {
    report: InstallReport,
    cause: io::Error,
}

impl std::fmt::Display for ActivatedInstallation {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.cause.fmt(output)
    }
}
impl std::error::Error for ActivatedInstallation {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.cause)
    }
}

/// Offline installation. Application data and provider skills are separate owners.
pub struct InstallRequest<'a> {
    pub archive: &'a Path,
    pub manifest: &'a Path,
    pub prefix: &'a Path,
    pub target: &'a str,
    pub channel: Channel,
    pub pin: PinAction,
}

/// The caller owns cancellation. Checkpoints never run inside atomic activation.
pub fn install(
    request: InstallRequest<'_>,
    checkpoint: impl FnMut() -> io::Result<()>,
) -> io::Result<InstallReport> {
    install_observed(request, None, None, checkpoint)
}

fn install_observed(
    request: InstallRequest<'_>,
    expected: Option<uuid::Uuid>,
    provenance: Option<receipt::GitHubProvenance>,
    mut checkpoint: impl FnMut() -> io::Result<()>,
) -> io::Result<InstallReport> {
    checkpoint()?;
    let artifact = artifact::acquire(request.manifest, request.archive, request.target)?;
    plan_version(None, &artifact.version, request.channel, request.pin)
        .map_err(io::Error::other)?;
    checkpoint()?;
    let layout = publication::Layout::open(request.prefix)?;
    let _lock = crate::file_lock::exclusive(&layout.root.join("install.lock"))?;
    let current = layout.current()?;
    if let Some(expected) = expected
        && current.as_ref().map(|receipt| receipt.id) != Some(expected)
    {
        return Err(invalid(
            "The installed release or pin changed while downloading. Retry from the active executable.",
        ));
    }
    layout.check_links(current.is_some())?;
    let plan = plan_version(
        current.as_ref().map(|receipt| &receipt.state),
        &artifact.version,
        request.channel,
        request.pin,
    )
    .map_err(io::Error::other)?;
    if let Some(current) = &current
        && (current.target != artifact.target
            || (current.state.version == artifact.version
                && (current.archive_sha256 != artifact.sha256
                    || current.archive_name != artifact.name
                    || current.file_hashes != artifact.file_hashes())))
    {
        return Err(invalid(
            "Installed target or equal-version artifact integrity does not match.",
        ));
    }
    let active_id = if plan.changed {
        let mut receipt = receipt::Receipt::new(&artifact, plan.state);
        receipt.provenance = provenance;
        if let Err(error) = layout.publish(
            &artifact,
            &receipt,
            current.as_ref().map(|receipt| receipt.id),
            &mut checkpoint,
        ) {
            return Err(
                if error
                    .get_ref()
                    .is_some_and(|cause| cause.is::<publication::ActivatedError>())
                {
                    io::Error::new(
                        error.kind(),
                        ActivatedInstallation {
                            report: installed_report(
                                &layout,
                                &artifact.version.to_string(),
                                receipt.id,
                                true,
                            ),
                            cause: error,
                        },
                    )
                } else {
                    error
                },
            );
        }
        receipt.id
    } else {
        checkpoint()?;
        layout.ensure_links()?;
        current
            .as_ref()
            .expect("unchanged installation has a current receipt")
            .id
    };
    Ok(installed_report(
        &layout,
        &artifact.version.to_string(),
        active_id,
        plan.changed,
    ))
}

fn installed_report(
    layout: &publication::Layout,
    version: &str,
    active_id: uuid::Uuid,
    changed: bool,
) -> InstallReport {
    InstallReport {
        executable: layout.prefix.join("bin/tmt"),
        active_executable: layout
            .root
            .join("releases")
            .join(active_id.to_string())
            .join("tmt"),
        version: version.into(),
        changed,
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
