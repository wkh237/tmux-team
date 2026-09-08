//! New-executable composition for the native updater's managed-skill phase.

use crate::{invocation::OutputMode, output::Failure};
use serde_json::{Value, json};
use std::io::{self, Write};
use tmt_adapters::{
    config::ConfigPaths,
    skill_installation::{self, RefreshReport},
};

fn document(report: &RefreshReport) -> Value {
    json!({
        "refreshed": report.refreshed.iter().map(|item| json!({"target": item.target, "changed": item.changed})).collect::<Vec<_>>(),
        "skipped": report.skipped,
        "conflicts": report.conflicts,
    })
}

pub fn execute(mode: OutputMode) -> io::Result<u8> {
    let paths = match ConfigPaths::discover() {
        Ok(paths) => paths,
        Err(error) => return Failure::from(error).publish(mode),
    };
    let (report, failure) = match skill_installation::refresh(&paths.global_dir) {
        Ok(report) => (report, None),
        Err(error) => {
            let failure = Failure::new("SKILL_REFRESH_FAILED", error.to_string(), 1);
            (error.report, Some(failure))
        }
    };
    if mode.json {
        let mut value = document(&report);
        if let Some(failure) = &failure {
            value["error"] = failure.document()["error"].clone();
        }
        writeln!(io::stdout().lock(), "{value}")?;
    } else {
        let mut output = io::stdout().lock();
        for item in &report.refreshed {
            writeln!(
                output,
                "{} skill at {}",
                if item.changed { "Refreshed" } else { "Current" },
                item.target.display()
            )?;
        }
        for target in &report.skipped {
            writeln!(output, "Skipped missing skill at {}", target.display())?;
        }
        for target in &report.conflicts {
            writeln!(
                output,
                "Preserved conflicting skill at {}",
                target.display()
            )?;
        }
        if !report.refreshed.is_empty() {
            writeln!(
                output,
                "Reload or restart your agent to use the current skill. Existing conversations can read tmt learn --skill."
            )?;
        }
        if let Some(failure) = &failure {
            failure.publish(mode)?;
        }
    }
    Ok(if failure.is_some() { 1 } else { 0 })
}
