//! Thin configuration command composition and presentation. Policy and raw
//! document mutation remain in the shared core and filesystem adapter.

use crate::invocation::{ConfigRequest, OutputMode};
use crate::output::Failure;
use serde_json::json;
use std::io::{self, Write};
use tmt_adapters::config::{ConfigError, ConfigFiles, ConfigPaths, Scope};
use tmt_core::settings::{LocalClear, ResolvedSettings, Setting, SettingKey};

impl From<ConfigError> for Failure {
    fn from(error: ConfigError) -> Self {
        Self::new(error.code, error.message.clone(), 1).caused_by(error)
    }
}

fn invalid_setting(message: String) -> Failure {
    Failure::new("ERROR", message, 1)
}

enum Report {
    Show {
        loaded: ResolvedSettings,
        paths: ConfigPaths,
    },
    Changed(String),
}

fn run(request: ConfigRequest) -> Result<Report, Failure> {
    let files = ConfigFiles {
        paths: ConfigPaths::discover()?,
    };
    match request {
        ConfigRequest::Show => Ok(Report::Show {
            loaded: files.load()?,
            paths: files.paths,
        }),
        ConfigRequest::Set { key, value, global } => {
            let scope = if global { Scope::Global } else { Scope::Local };
            files.set(
                Setting::edit(&key, &value, scope).map_err(invalid_setting)?,
                scope,
            )?;
            let destination = if global {
                "global config"
            } else {
                "local config (repo override)"
            };
            Ok(Report::Changed(format!(
                "Set {key}={value} in {destination}"
            )))
        }
        ConfigRequest::Clear { key } => {
            files.clear_local(LocalClear::parse(key.as_deref()).map_err(invalid_setting)?)?;
            Ok(Report::Changed(key.map_or_else(
                || "Cleared all local config overrides".into(),
                |key| format!("Cleared local override for {key}"),
            )))
        }
    }
}

pub fn execute(request: ConfigRequest, mode: OutputMode) -> io::Result<u8> {
    let report = match run(request) {
        Ok(report) => report,
        Err(error) => return error.publish(mode),
    };
    let mut output = io::stdout().lock();
    match report {
        Report::Changed(message) => {
            if mode.json {
                writeln!(output, "{{\"ok\":true}}")?;
            } else {
                writeln!(output, "✓ {message}")?;
            }
        }
        Report::Show { loaded, paths } => {
            if mode.json {
                writeln!(output, "{}", show_json(&loaded, &paths))?;
            } else {
                show_text(&mut output, &loaded, &paths)?;
            }
        }
    }
    Ok(0)
}

fn show_json(loaded: &ResolvedSettings, paths: &ConfigPaths) -> serde_json::Value {
    let settings = &loaded.settings;
    json!({
        "resolved": {
            "preambleMode": settings.preamble_mode.as_str(),
            "preambleEvery": settings.preamble_every,
            "pasteEnterDelayMs": settings.paste_enter_delay_ms,
            "defaults": {
                "timeout": settings.timeout,
                "pollInterval": settings.poll_interval,
                "captureLines": settings.capture_lines,
                "preambleEvery": settings.preamble_every,
                "pasteEnterDelayMs": settings.paste_enter_delay_ms,
            },
            "exchange": { "retentionDays": settings.retention_days },
            "ui": { "paneBadge": settings.pane_badge.as_str() },
        },
        "sources": {
            "preambleMode": loaded.source(SettingKey::PreambleMode),
            "preambleEvery": loaded.source(SettingKey::PreambleEvery),
            "pasteEnterDelayMs": loaded.source(SettingKey::PasteEnterDelayMs),
            "exchange": { "retentionDays": loaded.source(SettingKey::RetentionDays) },
            "ui": { "paneBadge": loaded.source(SettingKey::PaneBadge) },
        },
        "paths": { "global": paths.global_config, "local": paths.local_config },
    })
}

fn show_text(
    output: &mut impl Write,
    loaded: &ResolvedSettings,
    paths: &ConfigPaths,
) -> io::Result<()> {
    let settings = &loaded.settings;
    let rows = [
        (
            "preambleMode",
            settings.preamble_mode.as_str().to_string(),
            loaded.source(SettingKey::PreambleMode),
        ),
        (
            "preambleEvery",
            settings.preamble_every.to_string(),
            loaded.source(SettingKey::PreambleEvery),
        ),
        (
            "pasteEnterDelayMs",
            settings.paste_enter_delay_ms.to_string(),
            loaded.source(SettingKey::PasteEnterDelayMs),
        ),
        ("defaults.timeout", settings.timeout.to_string(), "global"),
        (
            "defaults.pollInterval",
            settings.poll_interval.to_string(),
            "global",
        ),
        (
            "defaults.captureLines",
            settings.capture_lines.to_string(),
            "global",
        ),
        (
            "exchange.retentionDays",
            settings.retention_days.to_string(),
            loaded.source(SettingKey::RetentionDays),
        ),
        (
            "ui.paneBadge",
            settings.pane_badge.as_str().to_string(),
            loaded.source(SettingKey::PaneBadge),
        ),
    ];
    let key_width = rows.iter().map(|row| row.0.len()).max().unwrap_or(3).max(3);
    let value_width = rows.iter().map(|row| row.1.len()).max().unwrap_or(5).max(5);
    let source_width = rows
        .iter()
        .map(|row| row.2.len() + 2)
        .max()
        .unwrap_or(6)
        .max(6);
    writeln!(output, "ℹ Current configuration:\n")?;
    writeln!(
        output,
        "  {:key_width$} {:value_width$} {:source_width$}",
        "Key", "Value", "Source"
    )?;
    writeln!(
        output,
        "  {} {} {}",
        "─".repeat(key_width),
        "─".repeat(value_width),
        "─".repeat(source_width)
    )?;
    for (key, value, source) in rows {
        writeln!(
            output,
            "  {key:key_width$} {value:value_width$} {:source_width$}",
            format!("({source})")
        )?;
    }
    writeln!(output, "ℹ \nPaths:")?;
    writeln!(output, "ℹ   Global: {}", paths.global_config.display())?;
    writeln!(output, "ℹ   Local:  {}", paths.local_config.display())
}
