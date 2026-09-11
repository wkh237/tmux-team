//! Fixed Firebase REST operations; no caller-provided credential destination.

use super::{
    Approval, Claim, OfficeError, Proof,
    wire::{RESPONSE_LIMIT, valid_token},
};
use crate::{
    office_deployment::{DeploymentMode, OfficeDeployment},
    office_http,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use std::time::Instant;

pub fn claim_pairing(
    deployment: &OfficeDeployment,
    proof: &Proof,
    approval: &Approval,
    now_ms: u64,
    deadline: Instant,
) -> Result<Claim, OfficeError> {
    if proof.challenge() != approval.pairing_id() {
        return Err(OfficeError::CredentialsInvalid);
    }
    let bytes = post(
        deployment,
        &deployment.claim_url(),
        &serde_json::json!({"version":1,"secret":proof.secret()}).to_string(),
        "application/json",
        deadline,
        true,
    )?;
    Claim::decode(&bytes, approval, now_ms)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentCredential {
    id_token: String,
    refresh_token: String,
    token_expires_at: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Exchanged {
    id_token: String,
    refresh_token: String,
    expires_in: String,
}

#[derive(Deserialize)]
struct Refreshed {
    id_token: String,
    refresh_token: String,
    expires_in: String,
    token_type: String,
    user_id: String,
}

#[derive(Deserialize)]
struct TokenBinding {
    aud: String,
    iss: String,
    sub: String,
    #[serde(rename = "tmtOfficeAgent")]
    agent: bool,
    #[serde(rename = "tmtInstallationId")]
    installation_id: String,
    #[serde(rename = "tmtIdentityId")]
    identity_id: String,
}

impl AgentCredential {
    pub fn inspect_block(
        &self,
        deployment: &OfficeDeployment,
        block_id: &str,
        deadline: Instant,
    ) -> Result<bool, OfficeError> {
        if !super::wire::valid_uuid(block_id) || !valid_token(&self.id_token) {
            return Err(OfficeError::CredentialsInvalid);
        }
        let base = match deployment.target().mode() {
            DeploymentMode::Cloud => "https://firestore.googleapis.com",
            DeploymentMode::Emulator => "http://127.0.0.1:8080",
        };
        let name = format!(
            "projects/{}/databases/(default)/documents/worlds/{}/blocks/{block_id}",
            deployment.project_id(),
            deployment.target().world_id()
        );
        let agent = office_http::agent(deployment.target().mode(), deadline)
            .map_err(|_| OfficeError::RemoteUncertain)?;
        let mut response = agent
            .get(format!("{base}/v1/{name}"))
            .header("Authorization", &format!("Bearer {}", self.id_token))
            .header("Accept", "application/json")
            .header("Cache-Control", "no-store")
            .call()
            .map_err(|_| OfficeError::RemoteUncertain)?;
        match response.status().as_u16() {
            200 => {
                let bytes = office_http::json_body(&mut response, RESPONSE_LIMIT)
                    .map_err(|_| OfficeError::RemoteUncertain)?;
                #[derive(Deserialize)]
                struct Document {
                    name: String,
                }
                let document: Document =
                    serde_json::from_slice(&bytes).map_err(|_| OfficeError::CredentialsInvalid)?;
                if document.name != name {
                    return Err(OfficeError::CredentialsInvalid);
                }
                // Existence only: no parallel layout codec or unchecked fields.
                Ok(true)
            }
            404 => Ok(false),
            401 | 403 => Err(OfficeError::RemoteDenied),
            300..=399 => Err(OfficeError::CredentialsInvalid),
            _ => Err(OfficeError::RemoteUncertain),
        }
    }

    pub fn exchange(
        deployment: &OfficeDeployment,
        approval: &Approval,
        claim: &Claim,
        now_ms: u64,
        deadline: Instant,
    ) -> Result<Self, OfficeError> {
        let url = auth_url(deployment, "accounts:signInWithCustomToken");
        let bytes = post(
            deployment,
            &url,
            &serde_json::json!({"token":claim.custom_token,"returnSecureToken":true}).to_string(),
            "application/json",
            deadline,
            false,
        )?;
        let response: Exchanged =
            serde_json::from_slice(&bytes).map_err(|_| OfficeError::CredentialsInvalid)?;
        let value = Self::from_response(
            response.id_token,
            response.refresh_token,
            &response.expires_in,
            now_ms,
        )?;
        value.validate(deployment, approval, &claim.principal_uid)?;
        Ok(value)
    }

    pub fn refresh(
        &self,
        deployment: &OfficeDeployment,
        approval: &Approval,
        principal_uid: &str,
        now_ms: u64,
        deadline: Instant,
    ) -> Result<Self, OfficeError> {
        self.validate(deployment, approval, principal_uid)?;
        let base = match deployment.target().mode() {
            DeploymentMode::Cloud => "https://securetoken.googleapis.com/v1/token",
            DeploymentMode::Emulator => "http://127.0.0.1:9099/securetoken.googleapis.com/v1/token",
        };
        let url = format!("{base}?key={}", deployment.api_key());
        let body = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("grant_type", "refresh_token")
            .append_pair("refresh_token", &self.refresh_token)
            .finish();
        let bytes = post(
            deployment,
            &url,
            &body,
            "application/x-www-form-urlencoded",
            deadline,
            false,
        )?;
        let response: Refreshed =
            serde_json::from_slice(&bytes).map_err(|_| OfficeError::CredentialsInvalid)?;
        if response.token_type != "Bearer" || response.user_id != principal_uid {
            return Err(OfficeError::CredentialsInvalid);
        }
        let value = Self::from_response(
            response.id_token,
            response.refresh_token,
            &response.expires_in,
            now_ms,
        )?;
        value.validate(deployment, approval, principal_uid)?;
        Ok(value)
    }

    fn from_response(
        id_token: String,
        refresh_token: String,
        expires_in: &str,
        now_ms: u64,
    ) -> Result<Self, OfficeError> {
        let seconds: u64 = expires_in
            .parse()
            .map_err(|_| OfficeError::CredentialsInvalid)?;
        if !(1..=3600).contains(&seconds) || seconds.to_string() != expires_in {
            return Err(OfficeError::CredentialsInvalid);
        }
        let token_expires_at = now_ms
            .checked_add(seconds * 1000)
            .ok_or(OfficeError::CredentialsInvalid)?;
        Ok(Self {
            id_token,
            refresh_token,
            token_expires_at,
        })
    }

    pub fn validate(
        &self,
        deployment: &OfficeDeployment,
        approval: &Approval,
        principal_uid: &str,
    ) -> Result<(), OfficeError> {
        if !valid_token(&self.id_token) || !valid_token(&self.refresh_token) {
            return Err(OfficeError::CredentialsInvalid);
        }
        let segments = self.id_token.split('.').collect::<Vec<_>>();
        if segments.len() != 3 {
            return Err(OfficeError::CredentialsInvalid);
        }
        // This is response/binding consistency, not JWT signature verification
        // or authorization. Fixed HTTPS Auth issued the token; live Firestore
        // Rules authenticate it on every resource operation. Emulator mode is
        // explicitly isolated and never accepted as cloud authority.
        let payload = URL_SAFE_NO_PAD
            .decode(segments[1])
            .map_err(|_| OfficeError::CredentialsInvalid)?;
        let binding: TokenBinding =
            serde_json::from_slice(&payload).map_err(|_| OfficeError::CredentialsInvalid)?;
        if binding.aud != deployment.project_id()
            || binding.iss != format!("https://securetoken.google.com/{}", deployment.project_id())
            || binding.sub != principal_uid
            || !binding.agent
            || binding.installation_id != approval.installation_id()
            || binding.identity_id != approval.identity_id()
        {
            return Err(OfficeError::CredentialsInvalid);
        }
        Ok(())
    }

    pub fn token_expires_at(&self) -> u64 {
        self.token_expires_at
    }
}

fn auth_url(deployment: &OfficeDeployment, operation: &str) -> String {
    let base = match deployment.target().mode() {
        DeploymentMode::Cloud => "https://identitytoolkit.googleapis.com/v1",
        DeploymentMode::Emulator => "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1",
    };
    format!("{base}/{operation}?key={}", deployment.api_key())
}

fn post(
    deployment: &OfficeDeployment,
    url: &str,
    body: &str,
    content_type: &str,
    deadline: Instant,
    claim: bool,
) -> Result<Vec<u8>, OfficeError> {
    let agent = office_http::agent(deployment.target().mode(), deadline)
        .map_err(|_| OfficeError::RemoteUncertain)?;
    let mut response = agent
        .post(url)
        .header("Content-Type", content_type)
        .header("Accept", "application/json")
        .header("Cache-Control", "no-store")
        .send(body)
        .map_err(|_| OfficeError::RemoteUncertain)?;
    match response.status().as_u16() {
        200 => office_http::json_body(&mut response, RESPONSE_LIMIT).map_err(|error| {
            if error.kind() == std::io::ErrorKind::InvalidData {
                OfficeError::CredentialsInvalid
            } else {
                OfficeError::RemoteUncertain
            }
        }),
        404 | 429 if claim => Err(OfficeError::PairingPending),
        400 | 401 | 403 if !claim => Err(OfficeError::RemoteDenied),
        300..=399 => Err(OfficeError::CredentialsInvalid),
        _ => Err(OfficeError::RemoteUncertain),
    }
}

#[cfg(test)]
#[path = "remote_tests.rs"]
mod tests;
