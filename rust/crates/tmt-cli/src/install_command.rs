//! Native skill installation composition; filesystem policy stays in adapters.

use crate::{invocation::OutputMode, output::Failure};
use serde_json::{Value, json};
use std::{
    error::Error,
    io::{self, Write},
    path::Path,
};
use tmt_adapters::{
    config::ConfigPaths,
    skill_installation::{self, InstallReport, InstalledSkill, ProviderEnvironment},
};

fn failure(error: impl Error + 'static) -> Failure {
    Failure::new("ERROR", error.to_string(), 1).caused_by(error)
}

fn document(item: &InstalledSkill) -> Value {
    let mut value = json!({"target": item.target, "changed": item.changed});
    if let Some(agent) = item.agent {
        value["agent"] = agent.as_str().into();
    }
    if let Some(backup) = &item.backup {
        value["backup"] = json!(backup);
    }
    if !item.legacy_backups.is_empty() {
        value["legacyBackups"] = json!(item.legacy_backups);
    }
    value
}

fn run(
    provider: Option<&str>,
    directory: Option<&str>,
    force: bool,
) -> Result<InstallReport, Failure> {
    let environment = ProviderEnvironment::capture().map_err(failure)?;
    let paths = ConfigPaths::discover()?;
    skill_installation::install(
        &environment,
        &paths.global_dir,
        provider,
        directory.map(Path::new),
        force,
    )
    .map_err(failure)
}

pub fn execute(
    provider: Option<String>,
    directory: Option<String>,
    force: bool,
    mode: OutputMode,
) -> io::Result<u8> {
    let report = match run(provider.as_deref(), directory.as_deref(), force) {
        Ok(report) => report,
        Err(error) => return error.publish(mode),
    };
    let mut output = io::stdout().lock();
    if mode.json {
        let mut value =
            json!({"installed": report.installed.iter().map(document).collect::<Vec<_>>()});
        if !report.warnings.is_empty() {
            value["warnings"] = json!(report.warnings);
        }
        writeln!(output, "{value}")?;
    } else {
        for item in &report.installed {
            writeln!(
                output,
                "{} {} skill at {}",
                if item.changed { "Installed" } else { "Current" },
                item.agent.map_or("shared", |agent| agent.as_str()),
                item.target.display()
            )?;
            for backup in item.backup.iter().chain(&item.legacy_backups) {
                writeln!(output, "Recoverable backup: {}", backup.display())?;
            }
        }
        for warning in &report.warnings {
            writeln!(output, "Warning: {warning}")?;
        }
        writeln!(
            output,
            "Reload or restart your agent to use the current skill. Existing conversations can read tmt learn --skill."
        )?;
    }
    Ok(0)
}
