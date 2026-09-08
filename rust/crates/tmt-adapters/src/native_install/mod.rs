//! Verified native release acquisition and managed publication, without app state.

mod artifact;
#[cfg(test)]
mod artifact_tests;
#[cfg(test)]
mod interrupt_tests;
mod publication;
#[cfg(test)]
mod publication_tests;
mod receipt;
#[cfg(test)]
mod test_support;

use std::{
    io,
    path::{Path, PathBuf},
};
use tmt_core::native_install::{Channel, PinAction, plan_version};

#[derive(Debug)]
pub struct InstallReport {
    pub executable: PathBuf,
    pub version: String,
    pub changed: bool,
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
    if plan.changed {
        let receipt = receipt::Receipt::new(&artifact, plan.state);
        layout.publish(
            &artifact,
            &receipt,
            current.as_ref().map(|receipt| receipt.id),
            &mut checkpoint,
        )?;
    } else {
        checkpoint()?;
        layout.ensure_links()?;
    }
    Ok(InstallReport {
        executable: layout.prefix.join("bin/tmt"),
        version: artifact.version.to_string(),
        changed: plan.changed,
    })
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
