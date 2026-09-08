//! Best-effort human guidance, never part of command success or machine output.

use crate::invocation::{Invocation, Parsed};
use std::io::{self, IsTerminal, Write};
use tmt_adapters::{
    config::ConfigPaths,
    skill_installation::{ProviderEnvironment, inspect_local_drift},
};

fn eligible(parsed: &Parsed, interactive: bool) -> bool {
    interactive
        && !parsed.mode.json
        && !matches!(
            parsed.invocation,
            Invocation::Help
                | Invocation::Version
                | Invocation::Completion(_)
                | Invocation::Init
                | Invocation::Learn { .. }
                | Invocation::Install { .. }
                | Invocation::Upgrade
                | Invocation::NativeInstall { .. }
                | Invocation::NativeRefreshSkills
        )
}

pub fn emit(parsed: &Parsed) {
    if !eligible(
        parsed,
        io::stdin().is_terminal() && io::stderr().is_terminal(),
    ) {
        return;
    }
    let Ok(env) = ProviderEnvironment::capture() else {
        return;
    };
    let Ok(paths) = ConfigPaths::discover() else {
        return;
    };
    let Ok(drift) = inspect_local_drift(&env, &paths.global_dir) else {
        return;
    };
    if let Some(first) = drift.first() {
        let _ = writeln!(
            io::stderr().lock(),
            "Skill guidance needs inspection at {} ({} location(s)). Run tmt install for the intended provider; inspect conflicts before using --force. Reload the agent afterward.",
            first.display(),
            drift.len()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::invocation::OutputMode;

    #[test]
    fn machine_and_setup_commands_never_trigger_passive_inspection() {
        let mut parsed = Parsed {
            invocation: Invocation::Whoami,
            mode: OutputMode::default(),
        };
        assert!(eligible(&parsed, true));
        assert!(!eligible(&parsed, false));
        parsed.mode.json = true;
        assert!(!eligible(&parsed, true));
        parsed.mode.json = false;
        for invocation in [
            Invocation::Help,
            Invocation::Version,
            Invocation::Completion(None),
            Invocation::Init,
            Invocation::Learn { skill: true },
            Invocation::Learn { skill: false },
            Invocation::Install {
                target: None,
                directory: None,
                force: false,
            },
            Invocation::Upgrade,
            Invocation::NativeRefreshSkills,
            Invocation::NativeInstall {
                archive: "archive.tar.gz".into(),
                manifest: "manifest.json".into(),
                prefix: "/explicit-prefix".into(),
                channel: tmt_core::native_install::Channel::Alpha,
                pin: tmt_core::native_install::PinAction::Preserve,
            },
        ] {
            parsed.invocation = invocation;
            assert!(!eligible(&parsed, true));
        }
    }
}
