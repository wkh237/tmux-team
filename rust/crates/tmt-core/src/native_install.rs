//! Pure release-channel and version policy; no filesystem or transport effects.

use semver::Version;
use std::{cmp::Ordering, error::Error, fmt};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Stable,
    Alpha,
}

impl Channel {
    pub const ALL: [Self; 2] = [Self::Stable, Self::Alpha];

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Alpha => "alpha",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|channel| channel.as_str().eq_ignore_ascii_case(value))
    }

    pub fn accepts(self, version: &Version) -> bool {
        match self {
            Self::Stable => version.pre.is_empty(),
            Self::Alpha => version.pre.as_str().split('.').next() == Some("alpha"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledVersion {
    pub version: Version,
    pub channel: Channel,
    pub pinned_version: Option<Version>,
}

impl InstalledVersion {
    pub fn validate(&self) -> Result<(), VersionError> {
        if !self.channel.accepts(&self.version)
            || self
                .pinned_version
                .as_ref()
                .is_some_and(|pinned| pinned != &self.version)
        {
            return Err(VersionError::InvalidCurrentState);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinAction {
    Preserve,
    PinCandidate,
    Clear,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionPlan {
    pub state: InstalledVersion,
    pub changed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VersionError {
    InvalidCurrentState,
    WrongChannel,
    Pinned,
    Downgrade,
    EqualPrecedenceChange,
}

impl fmt::Display for VersionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidCurrentState => "Installed version, channel and pin disagree.",
            Self::WrongChannel => "The selected version does not belong to the selected channel.",
            Self::Pinned => "The installation is pinned; explicitly select a version or unpin it.",
            Self::Downgrade => "Native installation does not permit a version downgrade.",
            Self::EqualPrecedenceChange => {
                "Build metadata alone cannot select a different installed release."
            }
        })
    }
}
impl Error for VersionError {}

/// Filesystem ownership and equal-version artifact integrity are separate
/// adapter checks. A version no-op never authorizes ignoring those checks.
pub fn plan_version(
    current: Option<&InstalledVersion>,
    candidate: &Version,
    channel: Channel,
    pin: PinAction,
) -> Result<VersionPlan, VersionError> {
    if let Some(current) = current {
        current.validate()?;
    }
    if !channel.accepts(candidate) {
        return Err(VersionError::WrongChannel);
    }
    let pinned_version = match pin {
        PinAction::PinCandidate => Some(candidate.clone()),
        PinAction::Clear => None,
        PinAction::Preserve => current.and_then(|state| state.pinned_version.clone()),
    };
    if pinned_version
        .as_ref()
        .is_some_and(|pinned| pinned != candidate)
    {
        return Err(VersionError::Pinned);
    }
    if let Some(current) = current {
        match candidate.cmp_precedence(&current.version) {
            Ordering::Less => return Err(VersionError::Downgrade),
            Ordering::Equal if candidate != &current.version => {
                return Err(VersionError::EqualPrecedenceChange);
            }
            Ordering::Equal | Ordering::Greater => {}
        }
    }
    let state = InstalledVersion {
        version: candidate.clone(),
        channel,
        pinned_version,
    };
    Ok(VersionPlan {
        changed: current != Some(&state),
        state,
    })
}

#[cfg(test)]
mod tests;
