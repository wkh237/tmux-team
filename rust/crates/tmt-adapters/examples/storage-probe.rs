//! Development-only lifecycle probe for independent cross-runtime fixtures.
//! This is not a supported tmt command and is never an installed artifact.

use std::{
    io::{self, Write},
    process::ExitCode,
};
use tmt_adapters::storage::{CheckpointMode, Storage, StorageError};

fn run(path: &std::path::Path) -> Result<serde_json::Value, StorageError> {
    let mut storage = Storage::open(path)?;
    let observed = (|| {
        let health = storage.health()?;
        storage.checkpoint(CheckpointMode::Passive)?;
        Ok(serde_json::json!({
            "path": health.path, "open": true, "schemaVersion": health.schema_version,
            "journalMode": health.journal_mode, "foreignKeys": health.foreign_keys,
            "busyTimeoutMs": health.busy_timeout_ms, "synchronous": health.synchronous,
            "fts5": health.fts5,
        }))
    })();
    let cleanup = storage.close();
    let health = observed?;
    cleanup?;
    Ok(health)
}

fn main() -> ExitCode {
    let args = std::env::args_os().skip(1).collect::<Vec<_>>();
    if args.len() != 1 {
        eprintln!("Usage: storage-probe <isolated-database-path>");
        return ExitCode::FAILURE;
    }
    let (document, status) = match run(std::path::Path::new(&args[0])) {
        Ok(health) => (health, ExitCode::SUCCESS),
        Err(error) => (
            serde_json::json!({"error": {
                "code": error.code.as_str(), "message": error.message,
                "migrationVersion": error.migration_version, "retryable": error.retryable,
            }}),
            ExitCode::FAILURE,
        ),
    };
    if writeln!(io::stdout().lock(), "{document}").is_err() {
        return ExitCode::FAILURE;
    }
    status
}
