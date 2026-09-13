//! One embedded authored source, materialized without a checkout dependency.

use crate::bounded_file;
use crate::content_digest::sha256 as digest;
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub(super) const SKILL: &[u8] = include_bytes!("../../../../../skills/tmux-team/SKILL.md");
pub(super) const INBOX_SKILL: &[u8] = include_bytes!("../../../../../skills/tmt-inbox/SKILL.md");

fn digest_bundle(core: &[u8], inbox: &[u8]) -> String {
    let mut bytes = Vec::with_capacity(core.len() + inbox.len() + 16);
    bytes.extend_from_slice(&(core.len() as u64).to_be_bytes());
    bytes.extend_from_slice(core);
    bytes.extend_from_slice(&(inbox.len() as u64).to_be_bytes());
    bytes.extend_from_slice(inbox);
    digest(&bytes)
}

fn bundle_digest() -> String {
    digest_bundle(SKILL, INBOX_SKILL)
}

fn invalid(path: &Path) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!(
            "Managed skill source has been modified or is invalid: {}",
            path.display()
        ),
    )
}

/// Exact source inventory matters: an unexpected provider-readable file is not
/// made trusted merely because SKILL.md still matches its original digest.
fn source_bytes(source: &Path) -> io::Result<Vec<u8>> {
    let parent = source.parent().ok_or_else(|| invalid(source))?;
    if !fs::symlink_metadata(parent)?.is_dir() || !fs::symlink_metadata(source)?.is_dir() {
        return Err(invalid(source));
    }
    let mut entries = fs::read_dir(source)?;
    let entry = entries.next().ok_or_else(|| invalid(source))??;
    if entry.file_name() != "SKILL.md" || !entry.file_type()?.is_file() || entries.next().is_some()
    {
        return Err(invalid(source));
    }
    bounded_file::read(&entry.path(), 1_048_576)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

fn inventory(version: &Path) -> io::Result<Vec<String>> {
    if !fs::symlink_metadata(version)?.is_dir() {
        return Err(invalid(version));
    }
    let mut names = fs::read_dir(version)?
        .map(|entry| {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                return Err(invalid(version));
            }
            entry
                .file_name()
                .into_string()
                .map_err(|_| invalid(version))
        })
        .collect::<io::Result<Vec<_>>>()?;
    names.sort();
    Ok(names)
}

fn bundle_source_bytes(version: &Path) -> io::Result<(Vec<u8>, Vec<u8>)> {
    if inventory(version)? != ["tmt-inbox", "tmux-team"] {
        return Err(invalid(version));
    }
    Ok((
        source_bytes(&version.join("tmux-team"))?,
        source_bytes(&version.join("tmt-inbox"))?,
    ))
}

fn legacy_source_bytes(version: &Path) -> io::Result<Vec<u8>> {
    if inventory(version)? != ["tmux-team"] {
        return Err(invalid(version));
    }
    source_bytes(&version.join("tmux-team"))
}

pub(super) struct SkillAssets {
    root: PathBuf,
}

impl SkillAssets {
    pub(super) fn root(&self) -> &Path {
        &self.root
    }
    pub(super) fn new(global: &Path) -> Self {
        Self {
            root: global.join("skill-assets"),
        }
    }

    pub(super) fn source(&self) -> PathBuf {
        self.root.join(bundle_digest()).join("tmux-team")
    }

    pub(super) fn inbox_source(&self) -> PathBuf {
        self.root.join(bundle_digest()).join("tmt-inbox")
    }

    /// This is local managed-file evidence, not authentication of remote code.
    pub(super) fn owns(&self, source: &Path) -> bool {
        let Some(version) = source.parent() else {
            return false;
        };
        if version.parent() != Some(self.root.as_path()) {
            return false;
        }
        let Some(expected) = version.file_name().and_then(|name| name.to_str()) else {
            return false;
        };
        let source_name = match source.file_name().and_then(|name| name.to_str()) {
            Some(name @ ("tmux-team" | "tmt-inbox")) => name,
            _ => return false,
        };
        if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return false;
        }
        if bundle_source_bytes(version)
            .is_ok_and(|(core, inbox)| digest_bundle(&core, &inbox) == expected)
        {
            return true;
        }
        source_name == "tmux-team"
            && legacy_source_bytes(version).is_ok_and(|bytes| digest(&bytes) == expected)
    }

    /// Called while the installer lock is held. Existing sources are never
    /// overwritten, even with force; that flag authorizes target backups only.
    #[cfg(test)]
    pub(super) fn materialize(&self) -> io::Result<PathBuf> {
        self.materialize_bundle().map(|sources| sources.0)
    }

    pub(super) fn materialize_bundle(&self) -> io::Result<(PathBuf, PathBuf)> {
        let destination = self.source();
        let inbox_destination = self.inbox_source();
        if fs::symlink_metadata(&destination).is_ok()
            || fs::symlink_metadata(&inbox_destination).is_ok()
        {
            let (core, inbox) =
                bundle_source_bytes(destination.parent().expect("digest source directory"))?;
            if core != SKILL || inbox != INBOX_SKILL {
                return Err(invalid(&destination));
            }
            return Ok((destination, inbox_destination));
        }
        fs::create_dir_all(&self.root)?;
        let stage = self.root.join(format!(".stage-{}", Uuid::new_v4()));
        fs::create_dir(&stage)?;
        let pending = (|| {
            let directory = stage.join("tmux-team");
            fs::create_dir(&directory)?;
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(directory.join("SKILL.md"))?;
            file.write_all(SKILL)?;
            file.sync_all()?;
            drop(file);
            let inbox_directory = stage.join("tmt-inbox");
            fs::create_dir(&inbox_directory)?;
            let mut inbox_file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(inbox_directory.join("SKILL.md"))?;
            inbox_file.write_all(INBOX_SKILL)?;
            inbox_file.sync_all()?;
            drop(inbox_file);
            let parent = destination.parent().expect("digest source directory");
            // An invalid digest directory is not disposable user data.
            if fs::symlink_metadata(parent).is_ok() {
                return Err(invalid(parent));
            }
            fs::rename(&stage, parent)?;
            Ok((destination, inbox_destination))
        })();
        if stage.exists()
            && let Err(cleanup) = fs::remove_dir_all(&stage)
        {
            return Err(io::Error::other(format!(
                "{}; could not remove owned staging directory {}: {cleanup}",
                pending
                    .as_ref()
                    .err()
                    .map(ToString::to_string)
                    .unwrap_or_else(|| "Skill publication failed".into()),
                stage.display()
            )));
        }
        pending
    }
}
