//! Read-only saved-identity notes, never caller-selected filesystem paths.

use super::{Request, response};
use serde_json::json;
use std::{io, net::TcpStream};
use tmt_adapters::{
    config::ConfigPaths,
    notes::{self, NotebookError},
};

pub(super) const PREFIX: &str = "/api/v1/local/notebooks/";

pub(super) fn api(stream: &mut TcpStream, request: Request, paths: &ConfigPaths) -> io::Result<()> {
    let Some(id) = request
        .path
        .strip_prefix(PREFIX)
        .filter(|id| tmt_core::dispatch::canonical_id(id))
    else {
        return response(stream, 404, "application/json", br#"{"error":"NOT_FOUND"}"#);
    };
    if request.method != "GET" {
        return response(
            stream,
            405,
            "application/json",
            br#"{"error":"METHOD_NOT_ALLOWED"}"#,
        );
    }
    let (status, body) = match notes::read(paths, id) {
        Ok(notebook) => (
            200,
            json!({ "identityId": notebook.identity_id, "name": notebook.name, "content": notebook.content }),
        ),
        Err(error) => {
            let (status, code) = match error {
                NotebookError::InvalidIdentity => (400, "NOTEBOOK_INVALID_IDENTITY"),
                NotebookError::IdentityNotFound => (404, "NOTEBOOK_IDENTITY_NOT_FOUND"),
                NotebookError::SavedIdentityRequired => (403, "NOTEBOOK_SAVED_IDENTITY_REQUIRED"),
                NotebookError::Missing => (404, "NOTEBOOK_NOT_FOUND"),
                NotebookError::TooLarge => (413, "NOTEBOOK_TOO_LARGE"),
                NotebookError::InvalidText => (422, "NOTEBOOK_INVALID_TEXT"),
                NotebookError::Unavailable => (500, "NOTEBOOK_UNAVAILABLE"),
            };
            (status, json!({ "error": code }))
        }
    };
    response(
        stream,
        status,
        "application/json",
        &serde_json::to_vec(&body)?,
    )
}

#[cfg(test)]
mod tests;
