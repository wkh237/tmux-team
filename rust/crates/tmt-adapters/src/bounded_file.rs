//! Shared bounded regular-file acquisition; callers own text semantics.

use nix::fcntl::OFlag;
use std::{
    error::Error,
    fmt,
    fs::OpenOptions,
    io::{self, Read},
    os::unix::fs::OpenOptionsExt,
    path::Path,
};

#[derive(Debug)]
pub enum FileReadError {
    TooLarge,
    Io(io::Error),
}
impl fmt::Display for FileReadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::TooLarge => "File exceeds the input bound.",
            Self::Io(_) => "Could not read a regular input file.",
        })
    }
}
impl Error for FileReadError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::TooLarge => None,
        }
    }
}

pub fn read(path: &Path, maximum: usize) -> Result<Vec<u8>, FileReadError> {
    let bound = maximum.checked_add(1).ok_or(FileReadError::TooLarge)?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(OFlag::O_NONBLOCK.bits())
        .open(path)
        .map_err(FileReadError::Io)?;
    if !file.metadata().map_err(FileReadError::Io)?.is_file() {
        return Err(FileReadError::Io(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Input must be a regular file.",
        )));
    }
    let mut bytes = Vec::new();
    file.take(bound as u64)
        .read_to_end(&mut bytes)
        .map_err(FileReadError::Io)?;
    if bytes.len() > maximum {
        return Err(FileReadError::TooLarge);
    }
    Ok(bytes)
}
