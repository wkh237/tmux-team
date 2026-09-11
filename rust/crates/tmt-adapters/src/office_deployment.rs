//! Public Office deployment decoding. These values select scope, not authority.

use serde::Deserialize;
use std::{
    fmt, io,
    time::{Duration, Instant},
};
use ureq::{
    Agent,
    tls::{RootCerts, TlsConfig},
};
use url::Url;

pub const DEPLOYMENT_PATH: &str = "/.well-known/tmt-office.json";
pub const DEPLOYMENT_LIMIT: usize = 4096;
const URL_LIMIT: usize = 2048;
const DEMO_PROJECT: &str = "demo-tmt-office";
const DEMO_ISSUER: &str = "http://127.0.0.1:5001/demo-tmt-office/us-central1/officePairing";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DeploymentMode {
    Cloud,
    Emulator,
}

/// Error messages deliberately exclude untrusted document or URL contents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidDeployment;

impl fmt::Display for InvalidDeployment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Invalid Office deployment configuration or world URL.")
    }
}

impl std::error::Error for InvalidDeployment {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorldTarget {
    origin: String,
    world_id: String,
    mode: DeploymentMode,
}

impl WorldTarget {
    pub fn parse(value: &str, mode: DeploymentMode) -> Result<Self, InvalidDeployment> {
        let url = canonical_url(value)?;
        let world_id = url
            .path()
            .strip_prefix("/worlds/")
            .ok_or(InvalidDeployment)?;
        if world_id.len() != 20 || !world_id.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
            return Err(InvalidDeployment);
        }
        match mode {
            DeploymentMode::Cloud if url.scheme() == "https" => {}
            DeploymentMode::Emulator
                if url.scheme() == "http"
                    && url.host_str() == Some("127.0.0.1")
                    && url.port().is_some_and(|port| port != 0) => {}
            _ => return Err(InvalidDeployment),
        }
        Ok(Self {
            origin: url.origin().ascii_serialization(),
            world_id: world_id.to_owned(),
            mode,
        })
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub fn world_id(&self) -> &str {
        &self.world_id
    }

    pub fn discovery_url(&self) -> String {
        format!("{}{DEPLOYMENT_PATH}", self.origin)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Descriptor {
    version: u8,
    mode: DeploymentMode,
    project_id: String,
    api_key: String,
    pairing_url: String,
}

/// Immutable validated deployment. Private fields prevent bypassing the decoder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OfficeDeployment {
    target: WorldTarget,
    project_id: String,
    api_key: String,
    pairing_url: String,
}

impl OfficeDeployment {
    /// Unauthenticated acquisition from the explicitly selected website only.
    pub fn discover(target: WorldTarget, deadline: Instant) -> io::Result<Self> {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|remaining| !remaining.is_zero())
            .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "Office discovery timed out."))?
            .min(Duration::from_secs(10));
        let agent = Agent::new_with_config(
            Agent::config_builder()
                .https_only(target.mode == DeploymentMode::Cloud)
                .max_redirects(0)
                .max_response_header_size(16 * 1024)
                .timeout_global(Some(remaining))
                .tls_config(
                    TlsConfig::builder()
                        .root_certs(RootCerts::PlatformVerifier)
                        .build(),
                )
                .build(),
        );
        let mut response = agent
            .get(target.discovery_url())
            .header("Accept", "application/json")
            .header("Cache-Control", "no-store")
            .call()
            .map_err(discovery_failure)?;
        if response.status().as_u16() != 200
            || !response
                .headers()
                .get("content-type")
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| {
                    value
                        .split(';')
                        .next()
                        .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
                })
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                InvalidDeployment,
            ));
        }
        let bytes = response
            .body_mut()
            .with_config()
            .limit((DEPLOYMENT_LIMIT + 1) as u64)
            .read_to_vec()
            .map_err(discovery_failure)?;
        Self::decode(target, &bytes)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
    }

    pub fn decode(target: WorldTarget, bytes: &[u8]) -> Result<Self, InvalidDeployment> {
        if bytes.len() > DEPLOYMENT_LIMIT {
            return Err(InvalidDeployment);
        }
        // Deserialize the typed object directly: a Value round trip would discard
        // duplicate keys before Serde can reject them.
        let descriptor: Descriptor =
            serde_json::from_slice(bytes).map_err(|_| InvalidDeployment)?;
        if descriptor.version != 1
            || descriptor.mode != target.mode
            || descriptor.api_key.is_empty()
            || descriptor.api_key.len() > 256
            || !descriptor
                .api_key
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            || descriptor.pairing_url.ends_with('/')
        {
            return Err(InvalidDeployment);
        }
        // An origin-only issuer base omits the URL Standard's implicit slash.
        let issuer = parsed_url(&descriptor.pairing_url)?;
        if issuer.as_str().trim_end_matches('/') != descriptor.pairing_url {
            return Err(InvalidDeployment);
        }
        match descriptor.mode {
            DeploymentMode::Cloud
                if issuer.scheme() == "https"
                    && valid_project(&descriptor.project_id)
                    && !descriptor.project_id.starts_with("demo-") => {}
            DeploymentMode::Emulator
                if descriptor.project_id == DEMO_PROJECT
                    && descriptor.api_key == DEMO_PROJECT
                    && descriptor.pairing_url == DEMO_ISSUER => {}
            _ => return Err(InvalidDeployment),
        }
        Ok(Self {
            target,
            project_id: descriptor.project_id,
            api_key: descriptor.api_key,
            pairing_url: descriptor.pairing_url,
        })
    }

    pub fn target(&self) -> &WorldTarget {
        &self.target
    }

    pub fn project_id(&self) -> &str {
        &self.project_id
    }

    pub fn api_key(&self) -> &str {
        &self.api_key
    }

    pub fn claim_url(&self) -> String {
        format!("{}/claim", self.pairing_url)
    }
}

fn canonical_url(value: &str) -> Result<Url, InvalidDeployment> {
    let url = parsed_url(value)?;
    if url.as_str() != value {
        return Err(InvalidDeployment);
    }
    Ok(url)
}

fn parsed_url(value: &str) -> Result<Url, InvalidDeployment> {
    if value.len() > URL_LIMIT {
        return Err(InvalidDeployment);
    }
    let url = Url::parse(value).map_err(|_| InvalidDeployment)?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(InvalidDeployment);
    }
    Ok(url)
}

fn valid_project(value: &str) -> bool {
    (6..=30).contains(&value.len())
        && value.as_bytes()[0].is_ascii_lowercase()
        && value.as_bytes()[value.len() - 1].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn discovery_failure(error: ureq::Error) -> io::Error {
    let kind = match error {
        ureq::Error::Timeout(_) => io::ErrorKind::TimedOut,
        ureq::Error::BodyExceedsLimit(_) => io::ErrorKind::InvalidData,
        _ => io::ErrorKind::Other,
    };
    io::Error::new(kind, "Office deployment discovery could not be confirmed.")
}

#[cfg(test)]
#[path = "office_deployment_tests.rs"]
mod tests;
