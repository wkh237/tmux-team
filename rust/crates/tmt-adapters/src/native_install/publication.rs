//! One durable release directory and one atomic activation pointer.

use super::{
    artifact::{Artifact, FILES},
    invalid,
    receipt::Receipt,
};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt, symlink},
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub(super) struct Layout {
    pub prefix: PathBuf,
    pub root: PathBuf,
}

fn directory(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
        Ok(_) => Err(invalid(
            "Native installation directory is occupied by another entry.",
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::DirBuilder::new().mode(0o700).create(path)?;
            if let Some(parent) = path.parent() {
                File::open(parent)?.sync_all()?;
            }
            Ok(())
        }
        Err(error) => Err(error),
    }
}

impl Layout {
    pub fn open(prefix: &Path) -> io::Result<Self> {
        if prefix.as_os_str().is_empty() {
            return Err(invalid("Installation prefix must not be empty."));
        }
        // Preserve the leaf entry: only ancestors may be symlink aliases.
        // Components also remove a trailing separator that could make lstat
        // follow a symlink supplied as the installation prefix.
        let requested: PathBuf = std::env::current_dir()?.join(prefix).components().collect();
        if let Some(parent) = requested.parent() {
            create_prefix_ancestors(parent)?;
        }
        directory(&requested)?;
        let prefix = fs::canonicalize(&requested)?;
        directory(&prefix.join("lib"))?;
        directory(&prefix.join("bin"))?;
        let root = prefix.join("lib/tmux-team");
        directory(&root)?;
        directory(&root.join("releases"))?;
        Ok(Self { prefix, root })
    }

    pub fn current(&self) -> io::Result<Option<Receipt>> {
        let pointer = self.root.join("current");
        let target = match fs::read_link(&pointer) {
            Ok(target) => target,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let id = target
            .to_str()
            .and_then(|target| target.strip_prefix("releases/"))
            .and_then(|id| Uuid::parse_str(id).ok())
            .filter(|id| target == Path::new(&format!("releases/{id}")))
            .ok_or_else(|| invalid("Native current pointer is not an owned release."))?;
        let release = self.root.join(&target);
        if !fs::symlink_metadata(&release)?.file_type().is_dir() {
            return Err(invalid("Native current release is not a real directory."));
        }
        Receipt::read(&release, &self.prefix, id).map(Some)
    }

    pub fn check_links(&self, has_current: bool) -> io::Result<()> {
        for name in ["tmt", "tmux-team"] {
            let path = self.prefix.join("bin").join(name);
            match fs::symlink_metadata(&path) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
                Ok(metadata)
                    if has_current
                        && metadata.file_type().is_symlink()
                        && fs::read_link(&path)? == Path::new("../lib/tmux-team/current/tmt") => {}
                Ok(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::AlreadyExists,
                        format!(
                            "Refusing to replace {}. Remove it using its original package manager or choose another prefix.",
                            path.display()
                        ),
                    ));
                }
            }
        }
        Ok(())
    }

    pub fn ensure_links(&self) -> io::Result<()> {
        self.check_links(true)?;
        for name in ["tmt", "tmux-team"] {
            let path = self.prefix.join("bin").join(name);
            match symlink("../lib/tmux-team/current/tmt", &path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    self.check_links(true)?
                }
                Err(error) => return Err(error),
            }
        }
        File::open(self.prefix.join("bin"))?.sync_all()
    }

    pub fn publish(
        &self,
        artifact: &Artifact,
        receipt: &Receipt,
        expected_current: Option<Uuid>,
        checkpoint: &mut impl FnMut() -> io::Result<()>,
    ) -> io::Result<()> {
        self.publish_with_finalization(artifact, receipt, expected_current, checkpoint, || {
            self.ensure_links()
        })
    }

    pub(super) fn publish_with_finalization(
        &self,
        artifact: &Artifact,
        receipt: &Receipt,
        expected_current: Option<Uuid>,
        checkpoint: &mut impl FnMut() -> io::Result<()>,
        finalize: impl FnOnce() -> io::Result<()>,
    ) -> io::Result<()> {
        checkpoint()?;
        let release = self.root.join("releases").join(receipt.id.to_string());
        fs::DirBuilder::new().mode(0o700).create(&release)?;
        let pointer = self.root.join(format!(".current-{}", receipt.id));
        let mut pointer_created = false;
        let mut activated = false;
        let result = (|| {
            for name in FILES {
                checkpoint()?;
                write(
                    &release.join(name),
                    &artifact.files[name],
                    if name == "tmt" { 0o755 } else { 0o644 },
                )?;
            }
            write(
                &release.join("receipt.json"),
                &receipt.encode(&self.prefix)?,
                0o600,
            )?;
            checkpoint()?;
            File::open(&release)?.sync_all()?;
            File::open(self.root.join("releases"))?.sync_all()?;
            symlink(format!("releases/{}", receipt.id), &pointer)?;
            pointer_created = true;
            checkpoint()?;
            if self.current()?.map(|receipt| receipt.id) != expected_current {
                return Err(invalid(
                    "Native current release changed during installation.",
                ));
            }
            self.check_links(expected_current.is_some())?;
            fs::rename(&pointer, self.root.join("current"))?;
            activated = true;
            File::open(&self.root)?.sync_all()?;
            finalize()
        })();
        if !activated {
            // A UUID name is not proof that this invocation created an entry.
            let pointer_cleanup = if pointer_created {
                fs::remove_file(&pointer)
            } else {
                Ok(())
            };
            let release_cleanup = fs::remove_dir_all(&release);
            if let Err(cleanup) = pointer_cleanup.and(release_cleanup) {
                return Err(io::Error::new(
                    result
                        .as_ref()
                        .err()
                        .map_or(cleanup.kind(), io::Error::kind),
                    format!(
                        "{}; owned staging cleanup failed: {cleanup}",
                        result.as_ref().err().map_or_else(
                            || "Native installation failed".into(),
                            ToString::to_string
                        )
                    ),
                ));
            }
        }
        result.map_err(|error| {
            if activated {
                io::Error::new(error.kind(), format!("Release activated, but installation finalization failed; retry to repair command links: {error}"))
            } else { error }
        })
    }
}

/// Prefix ancestors may be aliases; managed leaf entries may not. Track only
/// missing ancestors so their directory links can be synced after creation.
fn create_prefix_ancestors(parent: &Path) -> io::Result<()> {
    let mut missing = Vec::new();
    let mut cursor = parent;
    loop {
        match fs::symlink_metadata(cursor) {
            Ok(_) => break,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                missing.push(cursor);
                cursor = cursor.parent().ok_or(error)?;
            }
            Err(error) => return Err(error),
        }
    }
    fs::create_dir_all(parent)?;
    for directory in missing {
        File::open(directory)?.sync_all()?;
        if let Some(parent) = directory.parent() {
            File::open(parent)?.sync_all()?;
        }
    }
    Ok(())
}

fn write(path: &Path, bytes: &[u8], mode: u32) -> io::Result<()> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(mode)
        .open(path)?;
    file.write_all(bytes)?;
    file.set_permissions(fs::Permissions::from_mode(mode))?;
    file.sync_all()
}
