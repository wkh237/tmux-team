//! One-shot companion composition. Only allowlisted public data leaves this owner.

use super::{
    AgentCredential, Approval, OfficeError, OfficeInstallation, PairingRecord, Proof,
    ProtectedEntry, claim_pairing,
};
use crate::{
    config::ConfigPaths,
    office_deployment::{DeploymentMode, OfficeDeployment, WorldTarget},
    storage::Storage,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tmt_core::{identity::Identity, office_protocol::OfficeInvocation};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    world: String,
    identity_id: String,
    emulator: bool,
    read_only: bool,
}

pub fn execute(operation: OfficeInvocation, bytes: &[u8]) -> Vec<u8> {
    let result = run(operation, bytes);
    let value = result.unwrap_or_else(|error| json!({"error":error.code()}));
    serde_json::to_vec(&value).expect("public Office result is JSON data")
}

fn run(operation: OfficeInvocation, bytes: &[u8]) -> Result<Value, OfficeError> {
    if bytes.len() > 4096 || operation == OfficeInvocation::Probe {
        return Err(OfficeError::CredentialsInvalid);
    }
    if operation == OfficeInvocation::Sync {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct SyncRequest {}
        let _: SyncRequest =
            serde_json::from_slice(bytes).map_err(|_| OfficeError::CredentialsInvalid)?;
        let paths = ConfigPaths::discover().map_err(|_| OfficeError::CredentialsUnavailable)?;
        let report = super::hooks::sync(&paths, Instant::now() + Duration::from_secs(25))?;
        return Ok(
            json!({"completed":report.completed,"failed":report.failed,"pending":report.pending,"failureCode":report.failure.map(|error| error.code())}),
        );
    }
    let request: Request =
        serde_json::from_slice(bytes).map_err(|_| OfficeError::CredentialsInvalid)?;
    let mode = if request.emulator {
        DeploymentMode::Emulator
    } else {
        DeploymentMode::Cloud
    };
    let target =
        WorldTarget::parse(&request.world, mode).map_err(|_| OfficeError::DeploymentInvalid)?;
    let paths = ConfigPaths::discover().map_err(|_| OfficeError::CredentialsUnavailable)?;
    let identity = active_identity(&paths, &request.identity_id)?;
    let create = operation == OfficeInvocation::PairBegin;
    let Some(installation) = OfficeInstallation::open(&paths, create)? else {
        return if operation == OfficeInvocation::PairStatus {
            Ok(json!({"state":"unpaired"}))
        } else {
            Err(OfficeError::NotPaired)
        };
    };
    let deadline = Instant::now() + Duration::from_secs(25);
    let operate = |key: &str| {
        let entry = ProtectedEntry::open(key)?;
        let existing = entry
            .read()?
            .map(|bytes| PairingRecord::decode(&bytes, &target, installation.id(), &identity.id))
            .transpose()?;
        if existing.is_some() && operation != OfficeInvocation::PairStatus {
            super::hooks::register(&paths, &identity.id, key)?;
            active_identity(&paths, &identity.id)?;
        }
        match operation {
            OfficeInvocation::Inspect => {
                let mut record = existing.ok_or(OfficeError::NotPaired)?;
                if record.refresh_if_needed(&target, now_ms()?, deadline)? {
                    active_identity(&paths, &identity.id)?;
                    entry.write(&record.encode()?)?;
                }
                active_identity(&paths, &identity.id)?;
                if record.renew_if_needed(&target, now_ms()?, deadline)? {
                    active_identity(&paths, &identity.id)?;
                    entry.write(&record.encode()?)?;
                }
                active_identity(&paths, &identity.id)?;
                let exists = record.inspect(&target, now_ms()?, deadline)?;
                Ok(json!({"blockExists":exists}))
            }
            OfficeInvocation::PairStatus => {
                let now = now_ms()?;
                Ok(
                    json!({"state":existing.as_ref().map_or("unpaired", |record| record.local_state(now))}),
                )
            }
            OfficeInvocation::PairBegin => {
                let record = match existing {
                    Some(record) => {
                        if record.approval().read_only() != request.read_only {
                            return Err(OfficeError::CredentialsInvalid);
                        }
                        record
                    }
                    None => {
                        let deployment = OfficeDeployment::discover(target.clone(), deadline)
                            .map_err(|error| {
                                if error.kind() == std::io::ErrorKind::InvalidData {
                                    OfficeError::DeploymentInvalid
                                } else {
                                    OfficeError::RemoteUncertain
                                }
                            })?;
                        let proof = Proof::generate()?;
                        let approval = Approval::new(
                            &target,
                            installation.id(),
                            &identity.id,
                            &identity.name,
                            request.read_only,
                            &proof,
                        )?;
                        let record =
                            PairingRecord::pending(&deployment, approval, proof, now_ms()?)?;
                        active_identity(&paths, &identity.id)?;
                        entry.write(&record.encode()?)?;
                        super::hooks::register(&paths, &identity.id, key)?;
                        active_identity(&paths, &identity.id)?;
                        record
                    }
                };
                match record.local_state(now_ms()?) {
                    "pending" => Ok(
                        json!({"state":"pending","approvalUrl":record.approval().approval_url(&target)?}),
                    ),
                    "credential" => Ok(json!({"state":"credential"})),
                    _ => Err(OfficeError::PairingExpired),
                }
            }
            OfficeInvocation::PairPoll => {
                let mut record = existing.ok_or(OfficeError::NotPaired)?;
                if record.local_state(now_ms()?) == "credential" {
                    return Ok(json!({"state":"credential"}));
                }
                let proof = record.reserve_claim(now_ms()?)?;
                entry.write(&record.encode()?)?;
                active_identity(&paths, &identity.id)?;
                let deployment = record.deployment(&target)?;
                let claim =
                    claim_pairing(&deployment, &proof, record.approval(), now_ms()?, deadline)?;
                let credential = AgentCredential::exchange(
                    &deployment,
                    record.approval(),
                    &claim,
                    now_ms()?,
                    deadline,
                )?;
                active_identity(&paths, &identity.id)?;
                record.complete(claim, credential, &target)?;
                entry.write(&record.encode()?)?;
                active_identity(&paths, &identity.id)?;
                Ok(json!({"state":"credential"}))
            }
            OfficeInvocation::Probe | OfficeInvocation::Sync => {
                Err(OfficeError::CredentialsInvalid)
            }
        }
    };
    if operation == OfficeInvocation::PairStatus {
        operate(&installation.scope_key(&target, &identity.id)?)
    } else {
        installation.with_scope(&target, &identity.id, operate)
    }
}

fn active_identity(paths: &ConfigPaths, id: &str) -> Result<Identity, OfficeError> {
    let storage =
        Storage::open(&paths.database).map_err(|_| OfficeError::CredentialsUnavailable)?;
    storage
        .find_active_identity_by_id(id)
        .map_err(|_| OfficeError::CredentialsUnavailable)?
        .ok_or(OfficeError::NotPaired)
}

pub(super) fn now_ms() -> Result<u64, OfficeError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| OfficeError::CredentialsUnavailable)?
        .as_millis()
        .try_into()
        .map_err(|_| OfficeError::CredentialsUnavailable)
}
