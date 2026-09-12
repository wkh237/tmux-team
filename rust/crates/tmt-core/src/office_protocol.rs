//! Versioned internal companion handshake, not terminal output recognition.

use semver::Version;

pub const OFFICE_PROTOCOL_VERSION: &str = "1";
pub const OFFICE_PROTOCOL_OUTPUT_LIMIT: usize = 1024;
pub const OFFICE_HOOK_BATCH_LIMIT: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct OfficeSyncReport {
    pub completed: u64,
    pub failed: u64,
    pub pending: u64,
    pub failure: Option<OfficeError>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfficeError {
    DeploymentInvalid,
    CredentialsUnavailable,
    CredentialsInvalid,
    NotPaired,
    PairingPending,
    PairingExpired,
    RemoteDenied,
    RemoteUncertain,
}

impl OfficeError {
    pub fn code(self) -> &'static str {
        match self {
            Self::DeploymentInvalid => "OFFICE_DEPLOYMENT_INVALID",
            Self::CredentialsUnavailable => "OFFICE_CREDENTIALS_UNAVAILABLE",
            Self::CredentialsInvalid => "OFFICE_CREDENTIALS_INVALID",
            Self::NotPaired => "OFFICE_NOT_PAIRED",
            Self::PairingPending => "OFFICE_PAIRING_PENDING",
            Self::PairingExpired => "OFFICE_PAIRING_EXPIRED",
            Self::RemoteDenied => "OFFICE_REMOTE_DENIED",
            Self::RemoteUncertain => "OFFICE_REMOTE_UNCERTAIN",
        }
    }

    pub fn parse(code: &str) -> Option<Self> {
        [
            Self::DeploymentInvalid,
            Self::CredentialsUnavailable,
            Self::CredentialsInvalid,
            Self::NotPaired,
            Self::PairingPending,
            Self::PairingExpired,
            Self::RemoteDenied,
            Self::RemoteUncertain,
        ]
        .into_iter()
        .find(|value| value.code() == code)
    }
}

impl std::fmt::Display for OfficeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for OfficeError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfficeInvocation {
    Probe,
    PairBegin,
    PairPoll,
    PairStatus,
    Inspect,
    Sync,
}

impl OfficeInvocation {
    pub fn arguments(self) -> [&'static str; 3] {
        match self {
            Self::Probe => ["__tmt-office", OFFICE_PROTOCOL_VERSION, "probe"],
            Self::PairBegin => ["__tmt-office", OFFICE_PROTOCOL_VERSION, "pair-begin"],
            Self::PairPoll => ["__tmt-office", OFFICE_PROTOCOL_VERSION, "pair-poll"],
            Self::PairStatus => ["__tmt-office", OFFICE_PROTOCOL_VERSION, "pair-status"],
            Self::Inspect => ["__tmt-office", OFFICE_PROTOCOL_VERSION, "inspect"],
            Self::Sync => ["__tmt-office", OFFICE_PROTOCOL_VERSION, "sync"],
        }
    }

    pub fn parse(arguments: &[&str]) -> Result<Self, &'static str> {
        [
            Self::Probe,
            Self::PairBegin,
            Self::PairPoll,
            Self::PairStatus,
            Self::Inspect,
            Self::Sync,
        ]
        .into_iter()
        .find(|operation| arguments == operation.arguments())
        .ok_or("Unsupported Office invocation or protocol version.")
    }
}

pub fn encode_office_probe(version: &Version) -> String {
    format!("TMT-OFFICE/{OFFICE_PROTOCOL_VERSION}\n{version}\n")
}

pub fn decode_office_probe(bytes: &[u8]) -> Result<Version, &'static str> {
    if bytes.len() > OFFICE_PROTOCOL_OUTPUT_LIMIT {
        return Err("Office handshake exceeds its bound.");
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "Invalid Office handshake encoding.")?;
    let prefix = format!("TMT-OFFICE/{OFFICE_PROTOCOL_VERSION}\n");
    let version = text
        .strip_prefix(&prefix)
        .and_then(|text| text.strip_suffix('\n'))
        .ok_or("Incompatible Office handshake.")?;
    let parsed: Version = version
        .parse()
        .map_err(|_| "Invalid Office companion version.")?;
    if encode_office_probe(&parsed).as_bytes() != bytes {
        return Err("Noncanonical Office handshake.");
    }
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_invocation_and_independent_package_version_round_trip() {
        assert_eq!(
            OfficeInvocation::parse(&["__tmt-office", "1", "probe"]),
            Ok(OfficeInvocation::Probe)
        );
        let version = Version::parse("0.1.0-alpha.1").unwrap();
        assert_eq!(
            encode_office_probe(&version),
            "TMT-OFFICE/1\n0.1.0-alpha.1\n"
        );
        assert_eq!(
            decode_office_probe(b"TMT-OFFICE/1\n0.1.0-alpha.1\n"),
            Ok(version)
        );
    }

    #[test]
    fn pairing_operations_have_exact_versioned_arguments() {
        for (name, operation) in [
            ("pair-begin", OfficeInvocation::PairBegin),
            ("pair-poll", OfficeInvocation::PairPoll),
            ("pair-status", OfficeInvocation::PairStatus),
            ("inspect", OfficeInvocation::Inspect),
            ("sync", OfficeInvocation::Sync),
        ] {
            assert_eq!(operation.arguments(), ["__tmt-office", "1", name]);
            assert_eq!(
                OfficeInvocation::parse(&["__tmt-office", "1", name]),
                Ok(operation)
            );
            assert!(OfficeInvocation::parse(&["__tmt-office", "2", name]).is_err());
            assert!(OfficeInvocation::parse(&["__tmt-office", "1", name, "extra"]).is_err());
        }
    }

    #[test]
    fn unknown_versions_extra_arguments_and_noisy_responses_are_rejected() {
        for args in [
            vec![],
            vec!["__tmt-office", "2", "probe"],
            vec!["__tmt-office", "1", "probe", "extra"],
            vec!["__tmt-office", "1", "pair"],
        ] {
            assert!(OfficeInvocation::parse(&args).is_err());
        }
        for bytes in [
            b"TMT-OFFICE/2\n0.1.0\n".as_slice(),
            b"TMT-OFFICE/1\n0.1.0\nextra\n",
            b"noise\nTMT-OFFICE/1\n0.1.0\n",
            b"TMT-OFFICE/1\n0.1.0",
            b"TMT-OFFICE/1\nv0.1.0\n",
            b"\xff",
        ] {
            assert!(decode_office_probe(bytes).is_err());
        }
        assert!(decode_office_probe(&vec![b'x'; OFFICE_PROTOCOL_OUTPUT_LIMIT + 1]).is_err());
    }
}
