//! Read-only, fixed-provider inspection. Never scan custom installation intents
//! or executable search paths on ordinary commands.

use super::{ProviderEnvironment, assets::SkillAssets, files, managed_link};
use std::{
    collections::BTreeSet,
    io,
    path::{Path, PathBuf},
};
use tmt_core::skill_provider::Provider;

pub fn inspect_local_drift(env: &ProviderEnvironment, global: &Path) -> io::Result<Vec<PathBuf>> {
    let assets = SkillAssets::new(&files::resolved(global)?);
    let current = assets.source();
    let mut seen = BTreeSet::new();
    let mut drift = Vec::new();
    for provider in Provider::ALL {
        let target = env.target(provider);
        for (path, legacy) in std::iter::once((target, false)).chain(
            env.legacy_targets(provider)
                .into_iter()
                .map(|path| (path, true)),
        ) {
            if !seen.insert(path.clone()) || !files::exists(&path)? {
                continue;
            }
            if legacy || managed_link(&path, &assets)?.as_ref() != Some(&current) {
                drift.push(path);
            }
        }
    }
    Ok(drift)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{skill_installation::install, test_support::TestDirectory};
    use std::fs;

    #[test]
    fn missing_and_current_targets_are_quiet_while_legacy_and_modified_links_are_reported_once() {
        let root = TestDirectory::new();
        let home = root.path.join("home");
        fs::create_dir(&home).unwrap();
        let global = root.path.join("global");
        let env = ProviderEnvironment::from_parts(
            home.clone(),
            root.path.clone(),
            Vec::new(),
            None,
            None,
            None,
            None,
        );
        assert!(inspect_local_drift(&env, &global).unwrap().is_empty());
        assert!(!global.exists());
        install(&env, &global, Some("all"), None, false).unwrap();
        assert!(inspect_local_drift(&env, &global).unwrap().is_empty());
        // Deliberately corrupt intents: passive inspection must not read them.
        fs::write(global.join("skill-installations.json"), b"invalid").unwrap();
        let shared = home.join(".agents/skills/tmux-team");
        fs::remove_file(&shared).unwrap();
        std::os::unix::fs::symlink(home.join("missing"), &shared).unwrap();
        let legacy = home.join(".claude/commands/team.md");
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        fs::write(&legacy, b"legacy user content").unwrap();
        assert_eq!(
            inspect_local_drift(&env, &global).unwrap(),
            vec![legacy.clone(), shared.clone()]
        );
        assert_eq!(fs::read(&legacy).unwrap(), b"legacy user content");
        assert_eq!(fs::read_link(&shared).unwrap(), home.join("missing"));
        assert_eq!(
            fs::read(global.join("skill-installations.json")).unwrap(),
            b"invalid"
        );
        assert!(!global.join("state.db").exists());
    }
}
