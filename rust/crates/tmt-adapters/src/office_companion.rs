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
    OfficeSyncReport, decode_office_capabilities, decode_office_probe,
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
    if matches!(
        operation,
        OfficeInvocation::Probe
            | OfficeInvocation::Capabilities
            | OfficeInvocation::Sync
            | OfficeInvocation::BlockShow
            | OfficeInvocation::BlockApply
            | OfficeInvocation::LocalBlockShow
            | OfficeInvocation::LocalBlockApply
            | OfficeInvocation::LocalProfileShow
            | OfficeInvocation::LocalProfileApply
            | OfficeInvocation::BoardPost
            | OfficeInvocation::BoardList
            | OfficeInvocation::BoardShow
            | OfficeInvocation::BoardReply
            | OfficeInvocation::BoardEdit
            | OfficeInvocation::BoardDelete
            | OfficeInvocation::BoardCategories
    ) {
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

pub fn invoke_local_office_block(
    executable: &Path,
    identity_id: &str,
    edit: Option<(&tmt_core::office_block::BlockLayout, u64)>,
    deadline: Instant,
) -> io::Result<Result<serde_json::Value, OfficeError>> {
    let mut input = serde_json::json!({"identityId": identity_id});
    let operation = if let Some((layout, revision)) = edit {
        if revision >= tmt_core::office_block::MAX_REVISION {
            return Ok(Err(OfficeError::LayoutInvalid));
        }
        input["layout"] = crate::office_block::layout_value(layout);
        input["expectedRevision"] = serde_json::json!(revision);
        OfficeInvocation::LocalBlockApply
    } else {
        OfficeInvocation::LocalBlockShow
    };
    let input = serde_json::to_vec(&input)?;
    let bytes = match invoke_json(executable, operation, &input, deadline) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
            return Ok(Err(OfficeError::Busy));
        }
        Err(error) => return Err(error),
    };
    decode_local_block_reply(&bytes, identity_id)
}

pub fn invoke_local_office_profile(
    executable: &Path,
    identity_id: &str,
    edit: Option<(&tmt_core::office_profile::LocalProfile, u64)>,
    deadline: Instant,
) -> io::Result<Result<serde_json::Value, OfficeError>> {
    let mut input = serde_json::json!({"identityId":identity_id});
    let operation = if let Some((profile, revision)) = edit {
        if revision > tmt_core::office_profile::MAX_REVISION || profile.validate().is_err() {
            return Ok(Err(OfficeError::ProfileInvalid));
        }
        input["profile"] = crate::office_profile_wire::encode_value(profile);
        input["expectedRevision"] = serde_json::json!(revision);
        OfficeInvocation::LocalProfileApply
    } else {
        OfficeInvocation::LocalProfileShow
    };
    let input = serde_json::to_vec(&input)?;
    if input.len() > 4096 {
        return Err(invalid_pairing());
    }
    let bytes = match invoke_json(executable, operation, &input, deadline) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
            return Ok(Err(OfficeError::Busy));
        }
        Err(error) => return Err(error),
    };
    decode_local_profile_reply(&bytes, identity_id)
}

fn decode_local_profile_reply(
    bytes: &[u8],
    identity_id: &str,
) -> io::Result<Result<serde_json::Value, OfficeError>> {
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
    if object.len() != 7
        || ![
            "identityId",
            "identityName",
            "exists",
            "revision",
            "profile",
            "updatedAtMs",
            "catalog",
        ]
        .iter()
        .all(|key| object.contains_key(*key))
        || value["identityId"].as_str() != Some(identity_id)
        || value["identityName"].as_str().is_none_or(str::is_empty)
    {
        return Err(invalid_pairing());
    }
    crate::office_profile_wire::decode_value(value["profile"].clone())
        .map_err(|_| invalid_pairing())?;
    let expected_catalog = serde_json::json!({
        "hairStyles": tmt_core::office_profile::HAIR_STYLES,
        "hairColors": tmt_core::office_profile::HAIR_COLORS,
        "skinTones": tmt_core::office_profile::SKIN_TONES,
        "shirtColors": tmt_core::office_profile::SHIRT_COLORS,
    });
    if value["catalog"] != expected_catalog {
        return Err(invalid_pairing());
    }
    let exists = value["exists"].as_bool().ok_or_else(invalid_pairing)?;
    let revision = value["revision"].as_u64().ok_or_else(invalid_pairing)?;
    if revision > tmt_core::office_profile::MAX_REVISION
        || value["updatedAtMs"].as_u64().is_some_and(|timestamp| {
            timestamp == 0 || timestamp > tmt_core::limits::MAX_JS_SAFE_INTEGER
        })
        || (exists && (revision == 0 || value["updatedAtMs"].as_u64().is_none()))
        || (!exists && (revision != 0 || !value["updatedAtMs"].is_null()))
    {
        return Err(invalid_pairing());
    }
    Ok(Ok(value))
}

pub fn invoke_office_board(
    executable: &Path,
    operation: OfficeInvocation,
    input: &[u8],
    deadline: Instant,
) -> io::Result<Result<serde_json::Value, tmt_core::office_board::BoardErrorCode>> {
    if !matches!(
        operation,
        OfficeInvocation::BoardPost
            | OfficeInvocation::BoardList
            | OfficeInvocation::BoardShow
            | OfficeInvocation::BoardReply
            | OfficeInvocation::BoardEdit
            | OfficeInvocation::BoardDelete
            | OfficeInvocation::BoardCategories
    ) || input.len() > crate::office_board::BOARD_WIRE_LIMIT
    {
        return Err(invalid_pairing());
    }
    let capability_launch =
        native_install::with_active_product(Product::Office, executable, |installed| {
            start_selected(
                &installed.active_executable,
                OfficeInvocation::Capabilities,
                &[],
                deadline,
                OFFICE_PROTOCOL_OUTPUT_LIMIT,
            )
            .map(|running| (running, installed.release_id()))
        })
        .map_err(unsupported_office)?;
    let (capability_process, pinned_release) = capability_launch.map_err(unsupported_office)?;
    let capability_bytes = finish_selected(capability_process)
        .map_err(|error| io::Error::new(io::ErrorKind::Unsupported, error))?;
    require_board_capability(&capability_bytes, || ())?;
    let board_launch = native_install::with_active_product(
        Product::Office,
        executable,
        |installed| {
            if installed.release_id() != pinned_release {
                return Err(io::Error::new(
                    io::ErrorKind::Unsupported,
                    "Office release changed after capability verification; refusing board dispatch.",
                ));
            }
            start_selected(
                &installed.active_executable,
                operation,
                input,
                deadline,
                crate::office_board::BOARD_OUTPUT_LIMIT,
            )
        },
    )
    .map_err(unsupported_office)?;
    let board_process = board_launch.map_err(unsupported_office)?;
    let bytes = finish_selected(board_process)?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| invalid_pairing())?;
    if value.as_object().is_some_and(|object| object.len() == 1)
        && let Some(code) = value["error"].as_str()
    {
        let error = match code {
            "BOARD_INVALID" => tmt_core::office_board::BoardErrorCode::Invalid,
            "BOARD_THREAD_NOT_FOUND" => tmt_core::office_board::BoardErrorCode::ThreadNotFound,
            "BOARD_ENTRY_NOT_FOUND" => tmt_core::office_board::BoardErrorCode::EntryNotFound,
            "BOARD_REVISION_CONFLICT" => tmt_core::office_board::BoardErrorCode::RevisionConflict,
            "BOARD_FORBIDDEN" => tmt_core::office_board::BoardErrorCode::Forbidden,
            "BOARD_IDEMPOTENCY_CONFLICT" => {
                tmt_core::office_board::BoardErrorCode::IdempotencyConflict
            }
            "BOARD_CURSOR_INVALID" => tmt_core::office_board::BoardErrorCode::CursorInvalid,
            "BOARD_CURSOR_STALE" => tmt_core::office_board::BoardErrorCode::CursorStale,
            "STORAGE_ERROR" => tmt_core::office_board::BoardErrorCode::Storage,
            _ => return Err(invalid_pairing()),
        };
        return Ok(Err(error));
    }
    if !valid_board_success(operation, &value) {
        return Err(invalid_pairing());
    }
    Ok(Ok(value))
}

fn exact_keys(value: &serde_json::Value, keys: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|o| o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k)))
}
fn uuid_value(value: &serde_json::Value) -> bool {
    value.as_str().is_some_and(|s| {
        uuid::Uuid::parse_str(s)
            .ok()
            .is_some_and(|u| u.to_string() == s)
    })
}
fn safe_u64(value: &serde_json::Value) -> bool {
    value
        .as_u64()
        .is_some_and(|v| v <= tmt_core::limits::MAX_JS_SAFE_INTEGER)
}
fn positive_revision(value: &serde_json::Value) -> bool {
    safe_u64(value) && value.as_u64() != Some(0)
}
fn cursor_value(value: &serde_json::Value) -> bool {
    value.is_null()
        || value
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.len() <= tmt_core::office_board::CURSOR_MAX_BYTES)
}
fn category_value(value: &serde_json::Value) -> bool {
    exact_keys(value, &["kind"]) && value["kind"] == "general"
        || exact_keys(value, &["kind", "repositoryId"])
            && value["kind"] == "repository"
            && value["repositoryId"]
                .as_str()
                .is_some_and(tmt_core::office_board::valid_repository_id)
}
fn actor_value(value: &serde_json::Value) -> bool {
    exact_keys(value, &["kind"]) && value["kind"] == "owner"
        || exact_keys(value, &["kind", "identityId", "name"])
            && value["kind"] == "identity"
            && uuid_value(&value["identityId"])
            && value["name"].as_str().is_some_and(|s| {
                !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control)
            })
}
fn entry_value(value: &serde_json::Value, summary: bool) -> bool {
    let Some(o) = value.as_object() else {
        return false;
    };
    let required = [
        "id",
        "threadId",
        "category",
        "author",
        "revision",
        "deleted",
        "createdAtMs",
        "updatedAtMs",
    ];
    if !required.iter().all(|k| o.contains_key(*k))
        || !uuid_value(&value["id"])
        || !uuid_value(&value["threadId"])
        || !category_value(&value["category"])
        || !actor_value(&value["author"])
        || !positive_revision(&value["revision"])
        || value["deleted"].as_bool().is_none()
        || !safe_u64(&value["createdAtMs"])
        || !safe_u64(&value["updatedAtMs"])
    {
        return false;
    }
    let optional = if summary {
        &["title", "replyCount", "activitySequence"][..]
    } else {
        &["title", "body"][..]
    };
    if o.keys()
        .any(|k| !required.contains(&k.as_str()) && !optional.contains(&k.as_str()))
    {
        return false;
    }
    if value["deleted"] == true && (o.contains_key("title") || o.contains_key("body")) {
        return false;
    }
    if value["deleted"] == false
        && if summary {
            !o.contains_key("title")
        } else {
            !o.contains_key("body")
        }
    {
        return false;
    }
    if o.get("title").is_some_and(|v| {
        v.as_str().is_none_or(|s| {
            s.is_empty()
                || s.len() > tmt_core::office_board::TITLE_MAX_BYTES
                || s.chars().any(char::is_control)
        })
    }) {
        return false;
    }
    let body_max = if value["id"] == value["threadId"] {
        tmt_core::office_board::ROOT_BODY_MAX_BYTES
    } else {
        tmt_core::office_board::REPLY_BODY_MAX_BYTES
    };
    if o.get("body").is_some_and(|v| {
        v.as_str().is_none_or(|s| {
            s.is_empty()
                || s.len() > body_max
                || s.chars().any(|c| c.is_control() && c != '\n' && c != '\t')
        })
    }) {
        return false;
    }
    (!summary
        || value["id"] == value["threadId"]
            && safe_u64(&value["replyCount"])
            && positive_revision(&value["activitySequence"]))
        && o.get("title").is_none_or(|v| v.as_str().is_some())
        && o.get("body").is_none_or(|v| v.as_str().is_some())
}
fn valid_board_success(op: OfficeInvocation, value: &serde_json::Value) -> bool {
    match op {
        OfficeInvocation::BoardPost | OfficeInvocation::BoardReply => {
            exact_keys(
                value,
                &["entryId", "threadId", "revision", "created", "operationId"],
            ) && uuid_value(&value["entryId"])
                && uuid_value(&value["threadId"])
                && positive_revision(&value["revision"])
                && value["created"] == true
                && uuid_value(&value["operationId"])
                && if matches!(op, OfficeInvocation::BoardPost) {
                    value["entryId"] == value["threadId"]
                } else {
                    value["entryId"] != value["threadId"]
                }
        }
        OfficeInvocation::BoardEdit => {
            exact_keys(value, &["entryId", "revision", "changed", "operationId"])
                && uuid_value(&value["entryId"])
                && positive_revision(&value["revision"])
                && value["changed"].as_bool().is_some()
                && uuid_value(&value["operationId"])
        }
        OfficeInvocation::BoardDelete => {
            exact_keys(
                value,
                &[
                    "entryId",
                    "revision",
                    "deleted",
                    "changed",
                    "moderated",
                    "operationId",
                ],
            ) && uuid_value(&value["entryId"])
                && positive_revision(&value["revision"])
                && value["deleted"] == true
                && value["changed"].as_bool().is_some()
                && value["moderated"].as_bool().is_some()
                && uuid_value(&value["operationId"])
        }
        OfficeInvocation::BoardList => {
            exact_keys(value, &["threads", "nextCursor", "boardRevision"])
                && value["threads"]
                    .as_array()
                    .is_some_and(|a| a.len() <= 50 && a.iter().all(|v| entry_value(v, true)))
                && cursor_value(&value["nextCursor"])
                && safe_u64(&value["boardRevision"])
        }
        OfficeInvocation::BoardShow => {
            exact_keys(value, &["thread", "replies", "nextCursor", "boardRevision"])
                && entry_value(&value["thread"], false)
                && value["thread"]["id"] == value["thread"]["threadId"]
                && (value["thread"]["deleted"] == true
                    || value["thread"].as_object().unwrap().contains_key("title"))
                && value["replies"].as_array().is_some_and(|a| {
                    a.len() <= 50
                        && a.iter().all(|v| {
                            entry_value(v, false)
                                && v["threadId"] == value["thread"]["id"]
                                && v["id"] != v["threadId"]
                                && !v.as_object().unwrap().contains_key("title")
                                && v["category"] == value["thread"]["category"]
                        })
                })
                && cursor_value(&value["nextCursor"])
                && safe_u64(&value["boardRevision"])
        }
        OfficeInvocation::BoardCategories => {
            exact_keys(value, &["categories", "nextCursor", "boardRevision"])
                && value["categories"]
                    .as_array()
                    .is_some_and(|a| a.len() <= 50 && a.iter().all(category_value))
                && cursor_value(&value["nextCursor"])
                && safe_u64(&value["boardRevision"])
        }
        _ => false,
    }
}

fn require_board_capability<T>(bytes: &[u8], dispatch: impl FnOnce() -> T) -> io::Result<T> {
    decode_office_capabilities(bytes)
        .map_err(|message| io::Error::new(io::ErrorKind::Unsupported, message))?;
    Ok(dispatch())
}

fn decode_local_block_reply(
    bytes: &[u8],
    identity_id: &str,
) -> io::Result<Result<serde_json::Value, OfficeError>> {
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
    if object.len() != 7
        || ![
            "exists",
            "identityId",
            "identityName",
            "blockId",
            "revision",
            "objects",
            "updatedAtMs",
        ]
        .iter()
        .all(|key| object.contains_key(*key))
        || value["identityId"].as_str() != Some(identity_id)
        || value["identityName"].as_str().is_none_or(str::is_empty)
        || value["revision"].as_u64().is_none()
        || value["updatedAtMs"].as_u64().is_none()
    {
        return Err(invalid_pairing());
    }
    let exists = value["exists"].as_bool().ok_or_else(invalid_pairing)?;
    let block_id = value["blockId"].as_str();
    let valid_block_id = block_id.is_some_and(|id| {
        uuid::Uuid::parse_str(id)
            .ok()
            .is_some_and(|parsed| parsed.to_string() == id)
    });
    if (exists
        && (!valid_block_id
            || value["revision"]
                .as_u64()
                .is_none_or(|revision| revision == 0)
            || value["updatedAtMs"]
                .as_u64()
                .is_none_or(|updated| updated == 0)))
        || (!exists
            && (!value["blockId"].is_null()
                || value["revision"].as_u64() != Some(0)
                || value["updatedAtMs"].as_u64() != Some(0)))
    {
        return Err(invalid_pairing());
    }
    let layout = serde_json::to_vec(&serde_json::json!({"objects": value["objects"]}))?;
    crate::office_block::decode_layout(&layout).map_err(|_| invalid_pairing())?;
    Ok(Ok(value))
}

pub fn invoke_office_block(
    executable: &Path,
    call: &PairingCall<'_>,
    block_id: Option<&str>,
    edit: Option<(&tmt_core::office_block::BlockLayout, u64)>,
    deadline: Instant,
) -> io::Result<Result<crate::office_block::BlockSnapshot, OfficeError>> {
    let mut input = serde_json::json!({"world":call.world,"identityId":call.identity_id,"emulator":call.emulator,"readOnly":false,"blockId":block_id});
    let operation = if let Some((layout, revision)) = edit {
        if revision >= tmt_core::office_block::MAX_REVISION {
            return Ok(Err(OfficeError::LayoutInvalid));
        }
        input["layout"] = crate::office_block::layout_value(layout);
        input["expectedRevision"] = serde_json::json!(revision);
        OfficeInvocation::BlockApply
    } else {
        OfficeInvocation::BlockShow
    };
    let input = serde_json::to_vec(&input)?;
    if input.len() > 4096 {
        return Err(invalid_pairing());
    }
    let bytes = match invoke_json(executable, operation, &input, deadline) {
        Ok(bytes) => bytes,
        // The installer lock failed before the child was launched. Command
        // failures after launch are wrapped as Other by invoke_json and must
        // remain uncertain; never advertise a possibly committed write as busy.
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
            return Ok(Err(OfficeError::Busy));
        }
        Err(error) => return Err(error),
    };
    decode_block_reply(&bytes, block_id)
}

fn decode_block_reply(
    bytes: &[u8],
    block_id: Option<&str>,
) -> io::Result<Result<crate::office_block::BlockSnapshot, OfficeError>> {
    if bytes.len() > 4096 {
        return Err(invalid_pairing());
    }
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| invalid_pairing())?;
    if value.as_object().is_some_and(|object| object.len() == 1)
        && let Some(error) = value["error"].as_str().and_then(OfficeError::parse)
    {
        return Ok(Err(error));
    }
    let snapshot =
        crate::office_block::BlockSnapshot::decode(bytes).map_err(|_| invalid_pairing())?;
    if block_id.is_some_and(|id| id != snapshot.block_id) {
        return Err(invalid_pairing());
    }
    Ok(Ok(snapshot))
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
    invoke_json_bounded(executable, operation, input, deadline, 4096)
}

fn invoke_json_bounded(
    executable: &Path,
    operation: OfficeInvocation,
    input: &[u8],
    deadline: Instant,
    max_output_bytes: usize,
) -> io::Result<Vec<u8>> {
    let args = operation.arguments().map(OsString::from);
    let running = native_install::with_active_product(Product::Office, executable, |installed| {
        UnixCommandRunner
            .start(CommandRequest {
                program: installed.active_executable.as_os_str(),
                args: &args,
                input,
                deadline,
                max_output_bytes,
            })
            .map_err(io::Error::other)
    })??;
    let output = running.wait().map_err(io::Error::other)?;
    if !output.stderr.is_empty() {
        return Err(invalid_pairing());
    }
    Ok(output.stdout)
}

fn start_selected(
    executable: &Path,
    operation: OfficeInvocation,
    input: &[u8],
    deadline: Instant,
    max_output_bytes: usize,
) -> io::Result<RunningCommand> {
    let args = operation.arguments().map(OsString::from);
    UnixCommandRunner
        .start(CommandRequest {
            program: executable.as_os_str(),
            args: &args,
            input,
            deadline,
            max_output_bytes,
        })
        .map_err(io::Error::other)
}

fn finish_selected(running: RunningCommand) -> io::Result<Vec<u8>> {
    let output = running.wait().map_err(io::Error::other)?;
    if !output.stderr.is_empty() {
        return Err(invalid_pairing());
    }
    Ok(output.stdout)
}

fn unsupported_office(error: io::Error) -> io::Error {
    io::Error::new(io::ErrorKind::Unsupported, error)
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
    fn board_capability_prevents_dispatch_until_exactly_supported() {
        let mut dispatched = false;
        assert!(require_board_capability(b"TMT-OFFICE/1\n0.1.0\n", || dispatched = true).is_err());
        assert!(!dispatched);
        require_board_capability(
            tmt_core::office_protocol::encode_office_capabilities().as_bytes(),
            || dispatched = true,
        )
        .unwrap();
        assert!(dispatched);
    }

    #[test]
    fn board_success_replies_are_operation_exact_and_fail_closed() {
        let id = "11111111-1111-4111-8111-111111111111";
        let op = "22222222-2222-4222-8222-222222222222";
        let receipt = serde_json::json!({"entryId":id,"threadId":id,"revision":1,"created":true,"operationId":op});
        assert!(valid_board_success(OfficeInvocation::BoardPost, &receipt));
        let mut extra = receipt.clone();
        extra
            .as_object_mut()
            .unwrap()
            .insert("cursor".into(), serde_json::Value::Null);
        assert!(!valid_board_success(OfficeInvocation::BoardPost, &extra));
        assert!(!valid_board_success(OfficeInvocation::BoardEdit, &receipt));
        assert!(!valid_board_success(
            OfficeInvocation::BoardPost,
            &serde_json::json!({"entryId":"bad","threadId":id,"revision":1,"created":true,"operationId":op})
        ));
        let zero = serde_json::json!({"entryId":id,"threadId":id,"revision":0,"created":true,"operationId":op});
        assert!(!valid_board_success(OfficeInvocation::BoardPost, &zero));
        assert!(!valid_board_success(OfficeInvocation::BoardReply, &receipt));
        let mut not_created = receipt.clone();
        not_created["created"] = serde_json::json!(false);
        assert!(!valid_board_success(
            OfficeInvocation::BoardPost,
            &not_created
        ));
        assert!(!category_value(
            &serde_json::json!({"kind":"repository","repositoryId":"Bad Host/repo"})
        ));
        assert!(!actor_value(
            &serde_json::json!({"kind":"identity","identityId":id,"name":"bad\nname"})
        ));
        let summary = serde_json::json!({"id":id,"threadId":id,"category":{"kind":"general"},"author":{"kind":"owner"},"revision":1,"deleted":false,"createdAtMs":1,"updatedAtMs":1,"title":"x".repeat(tmt_core::office_board::TITLE_MAX_BYTES+1),"replyCount":0,"activitySequence":1});
        assert!(!entry_value(&summary, true));
        assert!(!valid_board_success(
            OfficeInvocation::BoardCategories,
            &serde_json::json!({"categories":[],"nextCursor":"x".repeat(tmt_core::office_board::CURSOR_MAX_BYTES+1),"boardRevision":1})
        ));
    }

    #[test]
    fn board_show_entries_enforce_root_reply_tombstone_and_content_invariants() {
        let root = "11111111-1111-4111-8111-111111111111";
        let reply = "22222222-2222-4222-8222-222222222222";
        let entry = |id: &str, thread: &str| serde_json::json!({"id":id,"threadId":thread,"category":{"kind":"general"},"author":{"kind":"owner"},"revision":1,"deleted":false,"createdAtMs":1,"updatedAtMs":1,"body":"body"});
        let mut root_entry = entry(root, root);
        root_entry
            .as_object_mut()
            .unwrap()
            .insert("title".into(), serde_json::json!("title"));
        let reply_entry = entry(reply, root);
        let valid = serde_json::json!({"thread":root_entry,"replies":[reply_entry],"nextCursor":null,"boardRevision":1});
        assert!(valid_board_success(OfficeInvocation::BoardShow, &valid));
        for invalid in [
            {
                let mut v = valid.clone();
                v["thread"].as_object_mut().unwrap().remove("title");
                v
            },
            {
                let mut v = valid.clone();
                v["replies"][0].as_object_mut().unwrap().remove("body");
                v
            },
            {
                let mut v = valid.clone();
                v["replies"][0]["category"] =
                    serde_json::json!({"kind":"repository","repositoryId":"github.com/O/R"});
                v
            },
            {
                let mut v = valid.clone();
                v["thread"]["revision"] = serde_json::json!(0);
                v
            },
            {
                let mut v = valid.clone();
                v["replies"][0]["body"] =
                    serde_json::json!("x".repeat(tmt_core::office_board::REPLY_BODY_MAX_BYTES + 1));
                v
            },
            {
                let mut v = valid.clone();
                v["thread"]["deleted"] = serde_json::json!(true);
                v
            },
        ] {
            assert!(!valid_board_success(OfficeInvocation::BoardShow, &invalid));
        }
    }

    #[test]
    fn local_block_replies_are_exact_and_distinguish_missing_from_existing() {
        let identity_id = "11111111-1111-4111-8111-111111111111";
        let block_id = "22222222-2222-4222-8222-222222222222";
        let existing = serde_json::json!({
            "exists": true,
            "identityId": identity_id,
            "identityName": "Alice",
            "blockId": block_id,
            "revision": 1,
            "objects": [],
            "updatedAtMs": 1
        });
        assert!(
            decode_local_block_reply(existing.to_string().as_bytes(), identity_id)
                .unwrap()
                .is_ok()
        );
        let missing = serde_json::json!({
            "exists": false,
            "identityId": identity_id,
            "identityName": "Alice",
            "blockId": null,
            "revision": 0,
            "objects": [],
            "updatedAtMs": 0
        });
        assert!(
            decode_local_block_reply(missing.to_string().as_bytes(), identity_id)
                .unwrap()
                .is_ok()
        );
        for invalid in [
            serde_json::json!({"exists":true,"identityId":identity_id,"identityName":"Alice","blockId":block_id,"revision":0,"objects":[],"updatedAtMs":1}),
            serde_json::json!({"exists":false,"identityId":identity_id,"identityName":"Alice","blockId":17,"revision":0,"objects":[],"updatedAtMs":0}),
            serde_json::json!({"exists":false,"identityId":identity_id,"identityName":"","blockId":null,"revision":0,"objects":[],"updatedAtMs":0}),
            serde_json::json!({"exists":false,"identityId":identity_id,"identityName":"Alice","blockId":null,"revision":0,"objects":[],"updatedAtMs":0,"token":"private"}),
        ] {
            assert!(decode_local_block_reply(invalid.to_string().as_bytes(), identity_id).is_err());
        }
    }

    #[test]
    fn block_replies_are_bounded_typed_and_match_explicit_targets() {
        let id = "11111111-1111-4111-8111-111111111111";
        let value = serde_json::json!({"blockId":id,"revision":0,"objects":[]});
        let bytes = serde_json::to_vec(&value).unwrap();
        assert_eq!(
            decode_block_reply(&bytes, Some(id))
                .unwrap()
                .unwrap()
                .revision,
            0
        );
        assert!(decode_block_reply(&bytes, Some("22222222-2222-4222-8222-222222222222")).is_err());
        assert_eq!(
            decode_block_reply(br#"{"error":"OFFICE_REVISION_CONFLICT"}"#, None).unwrap(),
            Err(OfficeError::RevisionConflict)
        );
        for invalid in [
            serde_json::json!({"blockId":id,"revision":0,"objects":[{"asset":"desk","x":0,"y":0,"rotation":0}]}),
            serde_json::json!({"blockId":id,"revision":1,"objects":[],"token":"unexpected"}),
            serde_json::json!({"blockId":id,"revision":1,"objects":["d000"]}),
            serde_json::json!({"error":"UNKNOWN"}),
            serde_json::json!({"state":"credential"}),
        ] {
            assert!(decode_block_reply(&serde_json::to_vec(&invalid).unwrap(), None).is_err());
        }
        assert!(decode_block_reply(&vec![b' '; 4097], None).is_err());
    }

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
