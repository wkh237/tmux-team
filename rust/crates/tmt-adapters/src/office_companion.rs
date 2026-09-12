//! Verified, bounded execution of the optional companion; never resolves PATH.

use crate::{
    native_install::{self, Product},
    process::{CommandRequest, RunningCommand, UnixCommandRunner},
};
use std::{
    ffi::OsString,
    io,
    path::Path,
    time::{Duration, Instant},
};
use tmt_core::office_protocol::{
    OFFICE_HOOK_BATCH_LIMIT, OFFICE_PROTOCOL_OUTPUT_LIMIT, OfficeError, OfficeInvocation,
    OfficeSyncReport, decode_office_probe,
};

pub struct PairingCall<'a> {
    pub world: &'a str,
    pub identity_id: &'a str,
    pub emulator: bool,
    pub read_only: bool,
}

pub enum PairingReply {
    Inspected(bool),
    Pending(String),
    State(String),
    Error(OfficeError),
}

/// Launch selection is short; all remote/vault work happens after releasing
/// the installer lock. Only nonsecret scope selectors cross stdin.
pub fn invoke_office_pairing(
    executable: &Path,
    operation: OfficeInvocation,
    call: &PairingCall<'_>,
    deadline: Instant,
) -> io::Result<PairingReply> {
    if matches!(operation, OfficeInvocation::Probe | OfficeInvocation::Sync) {
        return Err(invalid_pairing());
    }
    let input = serde_json::to_vec(
        &serde_json::json!({"world":call.world,"identityId":call.identity_id,"emulator":call.emulator,"readOnly":call.read_only}),
    )?;
    if input.len() > 4096 {
        return Err(invalid_pairing());
    }
    let bytes = invoke_json(executable, operation, &input, deadline)?;
    decode_pairing_reply(&bytes, call.world)
}

pub fn invoke_office_sync(
    executable: &Path,
    deadline: Instant,
) -> io::Result<Result<OfficeSyncReport, OfficeError>> {
    let bytes = invoke_json(executable, OfficeInvocation::Sync, b"{}", deadline)?;
    decode_sync_reply(&bytes)
}

fn invoke_json(
    executable: &Path,
    operation: OfficeInvocation,
    input: &[u8],
    deadline: Instant,
) -> io::Result<Vec<u8>> {
    let args = operation.arguments().map(OsString::from);
    let running = native_install::with_active_product(Product::Office, executable, |installed| {
        UnixCommandRunner
            .start(CommandRequest {
                program: installed.active_executable.as_os_str(),
                args: &args,
                input,
                deadline,
                max_output_bytes: 4096,
            })
            .map_err(io::Error::other)
    })??;
    let output = running.wait().map_err(io::Error::other)?;
    if !output.stderr.is_empty() {
        return Err(invalid_pairing());
    }
    Ok(output.stdout)
}

fn decode_sync_reply(bytes: &[u8]) -> io::Result<Result<OfficeSyncReport, OfficeError>> {
    if bytes.len() > 4096 {
        return Err(invalid_pairing());
    }
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| invalid_pairing())?;
    let object = value.as_object().ok_or_else(invalid_pairing)?;
    if object.len() == 1
        && let Some(error) = value["error"].as_str().and_then(OfficeError::parse)
    {
        return Ok(Err(error));
    }
    if object.len() != 4
        || !["completed", "failed", "pending", "failureCode"]
            .iter()
            .all(|key| object.contains_key(*key))
    {
        return Err(invalid_pairing());
    }
    let completed = value["completed"].as_u64().ok_or_else(invalid_pairing)?;
    let failed = value["failed"].as_u64().ok_or_else(invalid_pairing)?;
    let pending = value["pending"].as_u64().ok_or_else(invalid_pairing)?;
    let failure = match &value["failureCode"] {
        serde_json::Value::Null => None,
        serde_json::Value::String(code) => {
            Some(OfficeError::parse(code).ok_or_else(invalid_pairing)?)
        }
        _ => return Err(invalid_pairing()),
    };
    if completed
        .checked_add(failed)
        .is_none_or(|count| count > OFFICE_HOOK_BATCH_LIMIT as u64)
        || (failed == 0) != failure.is_none()
    {
        return Err(invalid_pairing());
    }
    Ok(Ok(OfficeSyncReport {
        completed,
        failed,
        pending,
        failure,
    }))
}

fn decode_pairing_reply(bytes: &[u8], world: &str) -> io::Result<PairingReply> {
    if bytes.len() > 4096 {
        return Err(invalid_pairing());
    }
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| invalid_pairing())?;
    let object = value.as_object().ok_or_else(invalid_pairing)?;
    if object.len() == 1 {
        if let Some(exists) = value["blockExists"].as_bool() {
            return Ok(PairingReply::Inspected(exists));
        }
        if let Some(error) = value["error"].as_str().and_then(OfficeError::parse) {
            return Ok(PairingReply::Error(error));
        }
        if let Some(state @ ("unpaired" | "pending" | "credential" | "expired" | "revoked")) =
            value["state"].as_str()
        {
            return Ok(PairingReply::State(state.into()));
        }
    }
    if object.len() == 2
        && value["state"] == "pending"
        && let Some(link) = value["approvalUrl"].as_str().filter(|link| {
            link.starts_with(&format!("{world}/pair#tmt-pair="))
                && !link.chars().any(char::is_control)
        })
    {
        return Ok(PairingReply::Pending(link.into()));
    }
    Err(invalid_pairing())
}

fn invalid_pairing() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "Invalid Office pairing response.",
    )
}

/// Local compatibility inspection only: does not pair, authenticate or start a service.
pub fn probe_office_companion(executable: &Path) -> io::Result<String> {
    let (running, version) =
        native_install::with_active_product(Product::Office, executable, |installed| {
            start_probe(&installed.active_executable)
                .map(|running| (running, installed.state.version.clone()))
        })??;
    finish_probe(running, &version)
}

pub(crate) fn probe_candidate(
    executable: &Path,
    expected_version: &semver::Version,
) -> io::Result<String> {
    finish_probe(start_probe(executable)?, expected_version)
}

fn start_probe(executable: &Path) -> io::Result<RunningCommand> {
    let args = OfficeInvocation::Probe.arguments().map(OsString::from);
    UnixCommandRunner
        .start(CommandRequest {
            program: executable.as_os_str(),
            args: &args,
            input: &[],
            deadline: Instant::now() + Duration::from_secs(5),
            max_output_bytes: OFFICE_PROTOCOL_OUTPUT_LIMIT,
        })
        .map_err(io::Error::other)
}

fn finish_probe(running: RunningCommand, expected_version: &semver::Version) -> io::Result<String> {
    let output = running.wait().map_err(io::Error::other)?;
    if !output.stderr.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Office handshake produced unexpected diagnostics.",
        ));
    }
    let version = decode_office_probe(&output.stdout)
        .map_err(|message| io::Error::new(io::ErrorKind::InvalidData, message))?;
    if &version != expected_version {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Office executable and installation versions disagree.",
        ));
    }
    Ok(version.to_string())
}

#[cfg(test)]
mod pairing_tests {
    use super::*;

    #[test]
    fn sync_reports_are_bounded_and_expose_only_public_delivery_state() {
        let report = serde_json::json!({"completed":1,"failed":1,"pending":2,"failureCode":"OFFICE_REMOTE_UNCERTAIN"});
        assert_eq!(
            decode_sync_reply(report.to_string().as_bytes())
                .unwrap()
                .unwrap(),
            OfficeSyncReport {
                completed: 1,
                failed: 1,
                pending: 2,
                failure: Some(OfficeError::RemoteUncertain),
            }
        );
        for (key, value) in [
            ("completed", serde_json::json!(-1)),
            ("completed", serde_json::json!(16)),
            ("pending", serde_json::json!("2")),
            ("failed", serde_json::json!(0)),
            ("failureCode", serde_json::Value::Null),
            ("failureCode", serde_json::json!("private diagnostic")),
            ("refreshToken", serde_json::json!("private")),
        ] {
            let mut invalid = report.clone();
            invalid[key] = value;
            assert!(
                decode_sync_reply(invalid.to_string().as_bytes()).is_err(),
                "{key}"
            );
        }
        assert_eq!(
            decode_sync_reply(br#"{"error":"OFFICE_CREDENTIALS_UNAVAILABLE"}"#).unwrap(),
            Err(OfficeError::CredentialsUnavailable)
        );
        assert!(decode_sync_reply(br#"{"completed":0}"#).is_err());
        assert!(decode_sync_reply(&vec![b' '; 4097]).is_err());
    }

    #[test]
    fn pairing_response_accepts_only_public_fields_and_the_selected_world() {
        let world = "https://office.example/worlds/abcdefghijklmnopqrst";
        assert!(
            matches!(decode_pairing_reply(br#"{"state":"unpaired"}"#, world), Ok(PairingReply::State(state)) if state == "unpaired")
        );
        assert!(matches!(
            decode_pairing_reply(br#"{"blockExists":false}"#, world),
            Ok(PairingReply::Inspected(false))
        ));
        assert!(matches!(
            decode_pairing_reply(br#"{"error":"OFFICE_NOT_PAIRED"}"#, world),
            Ok(PairingReply::Error(OfficeError::NotPaired))
        ));
        let link = format!("{world}/pair#tmt-pair=e30");
        let pending = serde_json::json!({"state":"pending","approvalUrl":link});
        assert!(
            matches!(decode_pairing_reply(pending.to_string().as_bytes(), world), Ok(PairingReply::Pending(value)) if value == link)
        );
        for value in [
            serde_json::json!({"state":"credential","refreshToken":"private"}),
            serde_json::json!({"state":"unknown"}),
            serde_json::json!({"error":"arbitrary-provider-diagnostic"}),
            serde_json::json!({"blockExists":"false"}),
            serde_json::json!({"state":"pending","approvalUrl":"https://other.example/pair#tmt-pair=e30"}),
            serde_json::json!({"state":"pending","approvalUrl":format!("{link}\n")}),
            serde_json::json!([]),
        ] {
            assert!(decode_pairing_reply(value.to_string().as_bytes(), world).is_err());
        }
        assert!(decode_pairing_reply(b"\xff", world).is_err());
        assert!(decode_pairing_reply(&vec![b' '; 4097], world).is_err());
    }
}
