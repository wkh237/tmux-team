use super::*;
use std::io::Write;

pub(super) fn publish(report: Report, mode: OutputMode) -> io::Result<u8> {
    let correlation = report.correlation;
    let mut stdout = io::stdout().lock();
    if mode.json {
        let mut value = serde_json::json!({"requestId": correlation.request_id, "target": correlation.target, "pane": correlation.pane});
        if let Some(identity) = correlation.identity {
            value["identity"] = serde_json::json!({"name": identity.name, "canonicalName": identity.canonical_name});
        }
        if let Some(response) = report.response {
            value["status"] = "completed".into();
            value["response"] = response.body.into();
            value["bodyBytes"] = response.body_bytes.into();
            value["submittedAtMs"] = response.submitted_at_ms.into();
        } else {
            value["status"] = "sent".into();
        }
        writeln!(stdout, "{value}")?;
    } else {
        if let Some(response) = report.response {
            writeln!(
                stdout,
                "Completed request {} for {} ({}).\n{}",
                correlation.request_id, correlation.target, correlation.pane, response.body
            )?;
        } else {
            writeln!(
                stdout,
                "Sent request {} to {} ({}).",
                correlation.request_id, correlation.target, correlation.pane
            )?;
        }
        writeln!(
            stdout,
            "Retrieve later with 'tmt result {}'.",
            correlation.request_id
        )?;
    }
    Ok(0)
}
