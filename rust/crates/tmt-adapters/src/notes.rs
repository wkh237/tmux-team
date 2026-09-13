//! Owner-local Markdown notebook initialization for saved identities.

use crate::config::ConfigPaths;
use nix::fcntl::OFlag;
use std::{
    fs::{self, DirBuilder, OpenOptions},
    io,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};
use tmt_core::identity::NotesIdentityId;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotesPath {
    pub path: PathBuf,
    pub created: bool,
}

pub fn initialize(paths: &ConfigPaths, identity_id: &NotesIdentityId) -> io::Result<NotesPath> {
    let (global_dir, identity_dir, notes_file) = paths.notes_layout(identity_id)?;
    require_directory(&global_dir)?;
    create_private_directory(&global_dir.join("notes"))?;
    create_private_directory(&identity_dir)?;

    let created = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(OFlag::O_NOFOLLOW.bits())
        .open(&notes_file)
    {
        Ok(file) => {
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
            file.sync_all()?;
            true
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            require_regular_file(&notes_file)?;
            false
        }
        Err(error) => return Err(error),
    };
    Ok(NotesPath {
        path: notes_file,
        created,
    })
}

fn create_private_directory(path: &Path) -> io::Result<()> {
    let mut builder = DirBuilder::new();
    builder.mode(0o700);
    match builder.create(path) {
        Ok(()) => {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => require_directory(path),
        Err(error) => Err(error),
    }
}

fn require_directory(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_dir() {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "{} is not a directory",
            path.display()
        )))
    }
}

fn require_regular_file(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_file() {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "{} is not a regular file",
            path.display()
        )))
    }
}

#[cfg(test)]
mod tests;
