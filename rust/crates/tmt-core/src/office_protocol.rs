//! Versioned internal companion handshake, not terminal output recognition.

use semver::Version;

pub const OFFICE_PROTOCOL_VERSION: &str = "1";
pub const OFFICE_PROTOCOL_OUTPUT_LIMIT: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfficeInvocation {
    Probe,
}

impl OfficeInvocation {
    pub fn arguments(self) -> [&'static str; 3] {
        match self {
            Self::Probe => ["__tmt-office", OFFICE_PROTOCOL_VERSION, "probe"],
        }
    }

    pub fn parse(arguments: &[&str]) -> Result<Self, &'static str> {
        if arguments == Self::Probe.arguments() {
            Ok(Self::Probe)
        } else {
            Err("Unsupported Office invocation or protocol version.")
        }
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
