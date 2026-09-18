//! Authenticated owner request composition; never a shell/CLI execution endpoint.

use super::{Request, require_json_origin, response};
use std::{io, net::TcpStream};
use tmt_adapters::{
    config::{ConfigFiles, ConfigPaths},
    dispatch::{decode_input, encode_receipt},
    office_service::ServiceReceipt,
    request_runtime::wall_time_ms,
    storage::{DispatchError, Storage},
};

pub(super) const PATH: &str = "/api/v1/local/dispatch";

#[cfg(test)]
mod tests;

pub(super) fn api(
    stream: &mut TcpStream,
    request: Request,
    paths: &ConfigPaths,
    receipt: &ServiceReceipt,
) -> io::Result<()> {
    if request.method != "POST" {
        return response(
            stream,
            405,
            "application/json",
            br#"{"error":"METHOD_NOT_ALLOWED"}"#,
        );
    }
    if let Err((status, body)) =
        require_json_origin(&request, &format!("http://127.0.0.1:{}", receipt.port))
    {
        return response(stream, status, "application/json", body);
    }
    let Some(input) = decode_input(&request.body) else {
        return response(
            stream,
            400,
            "application/json",
            br#"{"error":"DISPATCH_INVALID"}"#,
        );
    };
    let settings = match (ConfigFiles {
        paths: paths.clone(),
    })
    .load()
    {
        Ok(value) => value.settings,
        Err(_) => {
            return response(
                stream,
                500,
                "application/json",
                br#"{"error":"CONFIG_ERROR"}"#,
            );
        }
    };
    let mut storage = match Storage::open(&paths.database) {
        Ok(storage) => storage,
        Err(_) => {
            return response(
                stream,
                500,
                "application/json",
                br#"{"error":"STORAGE_UNAVAILABLE"}"#,
            );
        }
    };
    let result = storage.dispatch_request(input, settings.retention_days, wall_time_ms);
    let closed = storage.close();
    match result {
        Ok(receipt) if closed.is_ok() => {
            response(stream, 200, "application/json", &encode_receipt(&receipt))
        }
        Ok(_) => response(
            stream,
            500,
            "application/json",
            br#"{"error":"STORAGE_UNAVAILABLE"}"#,
        ),
        Err(error) => {
            let status = match error {
                DispatchError::Invalid => 400,
                DispatchError::IdempotencyConflict
                | DispatchError::RoomRosterChanged
                | DispatchError::RoomRecipientNotMember => 409,
                DispatchError::Request(_) | DispatchError::Storage(_) => 500,
            };
            response(
                stream,
                status,
                "application/json",
                &serde_json::to_vec(&serde_json::json!({"error":error.code()}))?,
            )
        }
    }
}
