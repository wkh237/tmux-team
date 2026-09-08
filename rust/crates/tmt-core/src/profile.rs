//! Roles and preambles share text/storage mechanics, not injection semantics.

#[cfg(test)]
mod tests;

use crate::{
    identity::{Identity, IdentityReader},
    names::ecmascript_space,
};
use std::{error::Error, fmt};

pub const MAX_PROFILE_BYTES: usize = 65_536;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileKind {
    Role,
    Preamble,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Profile {
    pub content: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedContent(String);
impl NormalizedContent {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContentError {
    TooLarge,
    Control,
    Empty,
}

impl fmt::Display for ContentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::TooLarge => "Content must not exceed 65536 bytes.",
            Self::Control => "Content must not contain control characters.",
            Self::Empty => "Content must not be empty or whitespace-only.",
        })
    }
}
impl Error for ContentError {}

pub fn normalize_content(value: &str) -> Result<NormalizedContent, ContentError> {
    if value.len() > MAX_PROFILE_BYTES {
        return Err(ContentError::TooLarge);
    }
    let normalized = value.replace("\r\n", "\n").replace('\r', "\n");
    let normalized = normalized.strip_prefix('\u{feff}').unwrap_or(&normalized);
    if normalized
        .chars()
        .any(|c| (c < '\u{20}' && c != '\t' && c != '\n') || c == '\u{7f}')
    {
        return Err(ContentError::Control);
    }
    if normalized.trim_matches(ecmascript_space).is_empty() {
        return Err(ContentError::Empty);
    }
    Ok(NormalizedContent(normalized.into()))
}

pub trait ProfileReader: IdentityReader {
    fn find_profile(
        &self,
        identity_id: &str,
        kind: ProfileKind,
    ) -> Result<Option<Profile>, Self::Error>;
    fn list_preambles(&self) -> Result<Vec<(Identity, Profile)>, Self::Error>;
}

pub trait ProfileWriter: IdentityReader {
    fn set_profile(
        &mut self,
        identity_id: &str,
        kind: ProfileKind,
        content: &str,
    ) -> Result<Profile, Self::Error>;
    fn clear_profile(&mut self, identity_id: &str, kind: ProfileKind) -> Result<bool, Self::Error>;
}

pub trait ProfileRepository: ProfileReader {
    fn with_profile_transaction<T>(
        &mut self,
        operation: impl FnOnce(&mut dyn ProfileWriter<Error = Self::Error>) -> Result<T, Self::Error>,
    ) -> Result<T, Self::Error>;
}

/// Recheck ownership in the write transaction. A stale observation must not
/// recreate a retired profile or write to a newly reused display name.
pub fn set_profile<R: ProfileRepository>(
    repository: &mut R,
    identity: &Identity,
    kind: ProfileKind,
    content: &NormalizedContent,
) -> Result<Option<Profile>, R::Error> {
    repository.with_profile_transaction(|records| {
        if !still_owned(records, identity)? {
            return Ok(None);
        }
        records
            .set_profile(&identity.id, kind, content.as_str())
            .map(Some)
    })
}

pub fn clear_profile<R: ProfileRepository>(
    repository: &mut R,
    identity: &Identity,
    kind: ProfileKind,
) -> Result<Option<bool>, R::Error> {
    repository.with_profile_transaction(|records| {
        if !still_owned(records, identity)? {
            return Ok(None);
        }
        records.clear_profile(&identity.id, kind).map(Some)
    })
}

fn still_owned<R: IdentityReader + ?Sized>(
    records: &R,
    identity: &Identity,
) -> Result<bool, R::Error> {
    records
        .find_identity(&identity.canonical_name)
        .map(|current| current.is_some_and(|current| current.id == identity.id))
}
