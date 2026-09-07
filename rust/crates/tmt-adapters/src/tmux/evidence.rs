use std::collections::{HashMap, HashSet};
use tmt_core::endpoint::{
    EndpointSnapshot, PaneObservation, ServerEvidence, valid_pane_id, valid_process_id,
    valid_server_id,
};

use super::{TmuxError, metadata};

pub(super) const SEPARATOR: &str = "__TMT_FIELD_4f1c__";

pub(super) fn server_format() -> String {
    [
        "#{@tmux-team.server-id}",
        "#{socket_path}",
        "#{pid}",
        "#{start_time}",
    ]
    .join(SEPARATOR)
}

pub(super) fn endpoint_format() -> String {
    [
        server_format(),
        [
            "#{pane_id}",
            "#{session_name}:#{window_index}.#{pane_index}",
            "#{pane_current_path}",
            "#{pane_current_command}",
            "#{pane_pid}",
            "#{session_attached}",
            "#{@tmux-team.agent}",
        ]
        .join(SEPARATOR),
    ]
    .join(SEPARATOR)
}

fn rows(output: &str) -> Vec<Vec<&str>> {
    output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| line.split(SEPARATOR).collect())
        .collect()
}

/// tmux and ps emit decimal integer fields. Do not accept JavaScript's broader
/// Number coercions (hex, exponents or signs) as process evidence.
pub(super) fn wire_integer(text: &str) -> Option<u64> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse()
        .ok()
        .filter(|value| tmt_core::limits::is_valid_js_safe_integer(*value))
}

fn positive_id(text: &str) -> Option<u64> {
    wire_integer(text).filter(|value| valid_process_id(*value))
}

fn server(rows: &[Vec<&str>], expected: Option<&str>) -> Result<ServerEvidence, TmuxError> {
    let first = rows
        .first()
        .filter(|row| row.len() >= 4)
        .ok_or_else(|| TmuxError::evidence("tmux server evidence is empty"))?;
    let server_pid = positive_id(first[2]).ok_or_else(|| {
        TmuxError::evidence("tmux endpoint snapshot contains inconsistent server evidence")
    })?;
    if !valid_server_id(first[0])
        || first[1].is_empty()
        || first[3].is_empty()
        || expected.is_some_and(|id| id != first[0])
        || rows.iter().any(|row| row.get(..4) != first.get(..4))
    {
        return Err(TmuxError::evidence(
            "tmux endpoint snapshot contains inconsistent server evidence",
        ));
    }
    Ok(ServerEvidence {
        server_id: first[0].into(),
        socket_path: first[1].into(),
        server_pid,
        server_start_time: first[3].into(),
    })
}

pub(super) fn parse_server(
    output: &str,
    expected: Option<&str>,
) -> Result<ServerEvidence, TmuxError> {
    server(&rows(output), expected)
}

pub(super) fn parse_snapshot(
    output: &str,
    expected: Option<&str>,
) -> Result<EndpointSnapshot, TmuxError> {
    let rows = rows(output);
    let server = server(&rows, expected)?;
    let mut indexes: HashMap<&str, usize> = HashMap::new();
    let mut observations: Vec<(PaneObservation, String, bool)> = Vec::new();
    for fields in rows {
        if fields.len() < 11 {
            return Err(TmuxError::evidence(
                "tmux endpoint snapshot contains inconsistent server evidence",
            ));
        }
        let pane_pid = positive_id(fields[8])
            .filter(|_| valid_pane_id(fields[4]))
            .ok_or_else(|| {
                TmuxError::evidence("tmux endpoint snapshot contains incomplete pane evidence")
            })?;
        let raw_metadata = fields[10..].join(SEPARATOR);
        let attached = positive_id(fields[9]).is_some();
        let text = |value: &str| (!value.is_empty()).then(|| value.to_string());
        let pane = PaneObservation {
            id: fields[4].into(),
            target: text(fields[5]),
            cwd: text(fields[6]),
            command: fields[7].into(),
            pane_pid,
            suggested_name: suggested_name(fields[7]),
            marker: metadata::marker(&metadata::decode(&raw_metadata)),
        };
        if let Some(index) = indexes.get(fields[4]) {
            let previous = &mut observations[*index];
            // Validate before deduplication. A malformed or conflicting linked
            // row must never disappear behind an earlier valid presentation.
            if previous.0.pane_pid != pane_pid || previous.1 != raw_metadata {
                return Err(TmuxError::evidence(
                    "tmux endpoint snapshot contains conflicting pane evidence",
                ));
            }
            if attached && !previous.2 {
                *previous = (pane, raw_metadata, attached);
            }
        } else {
            indexes.insert(fields[4], observations.len());
            observations.push((pane, raw_metadata, attached));
        }
    }
    Ok(EndpointSnapshot {
        server,
        panes: observations.into_iter().map(|(pane, _, _)| pane).collect(),
    })
}

fn suggested_name(command: &str) -> Option<String> {
    let command = command.to_lowercase();
    ["claude", "codex", "gemini", "aider", "cursor"]
        .into_iter()
        .find(|name| command.contains(name))
        .map(str::to_owned)
}

pub(super) fn scoped_ids(ids: Option<&[String]>) -> Result<Option<Vec<&str>>, TmuxError> {
    ids.map(|ids| {
        let mut scoped = Vec::new();
        let mut seen = HashSet::new();
        for id in ids {
            if !valid_pane_id(id) {
                return Err(TmuxError::evidence(
                    "tmux pane scope contains an invalid pane ID",
                ));
            }
            if seen.insert(id.as_str()) {
                scoped.push(id.as_str());
            }
        }
        Ok(scoped)
    })
    .transpose()
}

pub(super) fn pane_filter(ids: &[&str]) -> String {
    let mut expressions = ids.iter().map(|id| format!("#{{==:#{{pane_id}},{id}}}"));
    let first = expressions.next().expect("nonempty validated pane scope");
    expressions.fold(first, |combined, next| format!("#{{||:{combined},{next}}}"))
}
