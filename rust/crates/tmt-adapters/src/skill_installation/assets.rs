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
        self.root.join(digest(SKILL)).join("tmux-team")
    }

    /// This is local managed-file evidence, not authentication of remote code.
    pub(super) fn owns(&self, source: &Path) -> bool {
        let Some(version) = source.parent() else {
            return false;
        };
        if version.parent() != Some(self.root.as_path())
            || source.file_name().is_none_or(|name| name != "tmux-team")
        {
            return false;
        }
        let Some(expected) = version.file_name().and_then(|name| name.to_str()) else {
            return false;
        };
        expected.len() == 64
            && expected.bytes().all(|byte| byte.is_ascii_hexdigit())
            && source_bytes(source).is_ok_and(|bytes| digest(&bytes) == expected)
    }

    /// Called while the installer lock is held. Existing sources are never
    /// overwritten, even with force; that flag authorizes target backups only.
    pub(super) fn materialize(&self) -> io::Result<PathBuf> {
        let destination = self.source();
        if fs::symlink_metadata(&destination).is_ok() {
            if source_bytes(&destination)? != SKILL {
                return Err(invalid(&destination));
            }
            return Ok(destination);
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
            let parent = destination.parent().expect("digest source directory");
            // An invalid digest directory is not disposable user data.
            if fs::symlink_metadata(parent).is_ok() {
                return Err(invalid(parent));
            }
            fs::rename(&stage, parent)?;
            Ok(destination)
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
