use super::{InstallFailure, ProviderEnvironment, bundled_skill, install};
use crate::test_support::TestDirectory;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};
use tmt_core::skill_provider::Provider;

fn fixture() -> (TestDirectory, ProviderEnvironment, PathBuf, PathBuf) {
    let directory = TestDirectory::new();
    let home = directory.path.join("home");
    let cwd = directory.path.join("cwd");
    let global = directory.path.join("global");
    fs::create_dir(&home).unwrap();
    fs::create_dir(&cwd).unwrap();
    let home_for_return = home.clone();
    (
        directory,
        ProviderEnvironment::from_parts(home, cwd, Vec::new(), None, None, None, None),
        global,
        home_for_return,
    )
}

fn assert_link(path: &Path) -> PathBuf {
    assert!(fs::symlink_metadata(path).unwrap().is_symlink());
    fs::read_link(path).unwrap()
}

fn assert_failure_preserves(failure: &InstallFailure, expected: &str) {
    assert!(failure.to_string().contains(expected), "{failure}");
    assert!(failure.report.installed.is_empty());
    assert!(failure.pending_backup.is_none());
}

#[test]
fn neutral_install_is_exact_repeat_noop_and_records_one_target() {
    let (_directory, environment, global, home) = fixture();
    let first = install(&environment, &global, None, None, false).unwrap();
    assert_eq!(first.installed.len(), 1);
    assert_eq!(first.installed[0].agent, None);
    assert!(first.installed[0].changed);
    let universal = home.join(".agents/skills/tmux-team");
    let source = assert_link(&universal);
    assert_eq!(fs::read(source.join("SKILL.md")).unwrap(), bundled_skill());

    let registry = fs::read(global.join("skill-installations.json")).unwrap();
    let second = install(&environment, &global, None, None, false).unwrap();
    assert_eq!(second.installed.len(), 1);
    assert!(!second.installed[0].changed);
    assert_eq!(second.installed[0].backup, None);
    assert_eq!(assert_link(&universal), source);
    assert_eq!(
        fs::read(global.join("skill-installations.json")).unwrap(),
        registry
    );
    assert_eq!(fs::read(source.join("SKILL.md")).unwrap(), bundled_skill());
}

#[test]
fn custom_install_uses_exact_target_and_does_not_invent_provider() {
    let (directory, environment, global, _home) = fixture();
    let custom_root = PathBuf::from("custom skills");
    let report = install(&environment, &global, None, Some(&custom_root), false).unwrap();
    assert_eq!(report.installed.len(), 1);
    assert_eq!(report.installed[0].agent, None);
    assert!(report.installed[0].changed);
    let custom = directory.path.join("cwd/custom skills/tmux-team");
    assert_eq!(report.installed[0].target, custom);
    let source = assert_link(&custom);
    assert_eq!(fs::read(source.join("SKILL.md")).unwrap(), bundled_skill());
    assert_eq!(fs::read_dir(custom.parent().unwrap()).unwrap().count(), 1);
}

#[test]
fn all_install_deduplicates_shared_targets_but_reports_stable_provider_order() {
    let (_directory, environment, global, home) = fixture();
    let report = install(&environment, &global, Some("all"), None, false).unwrap();
    assert_eq!(
        report
            .installed
            .iter()
            .map(|item| item.agent.unwrap().as_str())
            .collect::<Vec<_>>(),
        vec!["claude", "codex", "gemini", "agy", "pi", "opencode"]
    );
    assert_eq!(
        report.installed.iter().filter(|item| item.changed).count(),
        4
    );
    for provider in Provider::ALL {
        assert!(
            fs::symlink_metadata(environment.target(provider))
                .unwrap()
                .is_symlink()
        );
    }
    let registry: serde_json::Value =
        serde_json::from_slice(&fs::read(global.join("skill-installations.json")).unwrap())
            .unwrap();
    assert_eq!(registry["version"], 1);
    let actual = registry["targets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|value| PathBuf::from(value.as_str().unwrap()))
        .collect::<BTreeSet<_>>();
    assert_eq!(registry["targets"].as_array().unwrap().len(), 4);
    let expected = [
        home.join(".claude/skills/tmux-team"),
        home.join(".agents/skills/tmux-team"),
        home.join(".gemini/config/skills/tmux-team"),
        home.join(".pi/agent/skills/tmux-team"),
    ]
    .into_iter()
    .collect::<BTreeSet<_>>();
    assert_eq!(actual, expected);
}

#[test]
fn unmanaged_file_directory_broken_and_wrong_links_refuse_without_force() {
    for kind in 0..4 {
        let (_directory, environment, global, home) = fixture();
        let target = home.join(".claude/skills/tmux-team");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        match kind {
            0 => fs::write(&target, b"user file").unwrap(),
            1 => {
                fs::create_dir(&target).unwrap();
                fs::write(target.join("user.md"), b"user directory").unwrap();
            }
            2 => std::os::unix::fs::symlink(home.join("missing"), &target).unwrap(),
            _ => {
                let wrong = home.join("wrong-skill");
                fs::create_dir(&wrong).unwrap();
                fs::write(wrong.join("SKILL.md"), b"wrong skill").unwrap();
                std::os::unix::fs::symlink(&wrong, &target).unwrap();
            }
        }
        let before = fs::read_dir(target.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        let failure = install(&environment, &global, Some("claude"), None, false).unwrap_err();
        assert_failure_preserves(&failure, "Refusing to replace existing unmanaged path");
        assert_eq!(
            fs::read_dir(target.parent().unwrap())
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect::<Vec<_>>(),
            before
        );
        match kind {
            0 => assert_eq!(fs::read(&target).unwrap(), b"user file"),
            1 => assert_eq!(fs::read(target.join("user.md")).unwrap(), b"user directory"),
            2 => assert_eq!(fs::read_link(&target).unwrap(), home.join("missing")),
            _ => {
                assert_eq!(fs::read_link(&target).unwrap(), home.join("wrong-skill"));
                assert_eq!(
                    fs::read(home.join("wrong-skill/SKILL.md")).unwrap(),
                    b"wrong skill"
                );
            }
        }
    }
}

#[test]
fn force_preserves_unmanaged_directory_and_broken_link_outside_discovery() {
    let (_directory, environment, global, home) = fixture();
    let target = home.join(".claude/skills/tmux-team");
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("user.md"), b"user-owned").unwrap();
    let report = install(&environment, &global, Some("claude"), None, true).unwrap();
    let backup = report.installed[0].backup.as_ref().unwrap();
    assert_eq!(
        backup.parent().unwrap(),
        home.join(".claude/.tmt-skill-backups")
    );
    assert!(backup.strip_prefix(home.join(".claude/skills")).is_err());
    assert_eq!(fs::read(backup.join("user.md")).unwrap(), b"user-owned");
    assert_eq!(
        fs::read(assert_link(&target).join("SKILL.md")).unwrap(),
        bundled_skill()
    );

    fs::remove_file(&target).unwrap();
    let missing = home.join("missing-skill");
    std::os::unix::fs::symlink(&missing, &target).unwrap();
    let broken_report = install(&environment, &global, Some("claude"), None, true).unwrap();
    let broken_backup = broken_report.installed[0].backup.as_ref().unwrap();
    assert!(fs::symlink_metadata(broken_backup).unwrap().is_symlink());
    assert_eq!(fs::read_link(broken_backup).unwrap(), missing);

    fs::remove_file(&target).unwrap();
    fs::write(&target, b"user file").unwrap();
    let file_report = install(&environment, &global, Some("claude"), None, true).unwrap();
    let file_backup = file_report.installed[0].backup.as_ref().unwrap();
    assert_eq!(fs::read(file_backup).unwrap(), b"user file");
}

#[test]
fn claude_legacy_is_warned_then_force_backed_up_without_touching_content() {
    let (_directory, environment, global, home) = fixture();
    let legacy = home.join(".claude/commands/team.md");
    fs::create_dir_all(legacy.parent().unwrap()).unwrap();
    fs::write(&legacy, b"legacy command").unwrap();
    let warning = install(&environment, &global, Some("claude"), None, false).unwrap();
    assert_eq!(fs::read(&legacy).unwrap(), b"legacy command");
    assert_eq!(warning.warnings.len(), 1);
    assert!(warning.warnings[0].contains("--force"));
    let forced = install(&environment, &global, Some("claude"), None, true).unwrap();
    let backup = forced.installed[0].legacy_backups.first().unwrap();
    assert_eq!(fs::read(backup).unwrap(), b"legacy command");
    assert!(backup.starts_with(home.join(".claude/.tmt-skill-backups")));
    assert!(!backup.starts_with(home.join(".claude/commands")));
    assert!(!legacy.exists());
}

#[test]
fn overlap_guards_run_before_materialization_or_target_backup() {
    let (_directory, environment, global, home) = fixture();
    let source_root = global.join("skill-assets");
    let target = home.join(".claude/skills/tmux-team");
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("user.md"), b"preserve").unwrap();
    let exact_root = source_root.clone();
    let exact = PathBuf::from("../global/skill-assets");
    let failure = install(&environment, &global, None, Some(&exact), true).unwrap_err();
    assert_failure_preserves(&failure, "overlaps bundled source");
    assert_eq!(fs::read(target.join("user.md")).unwrap(), b"preserve");
    assert!(!exact_root.exists());
}

#[test]
fn invalid_or_oversized_registry_is_preserved_and_prevents_materialization() {
    for bytes in [
        br#"{"version":2,"targets":[]}"#.to_vec(),
        vec![b'{'; 1_048_577],
    ] {
        let (_directory, environment, global, home) = fixture();
        fs::create_dir_all(&global).unwrap();
        let manifest = global.join("skill-installations.json");
        fs::write(&manifest, &bytes).unwrap();
        let failure = install(&environment, &global, Some("claude"), None, true).unwrap_err();
        assert_failure_preserves(&failure, "Invalid or oversized skill installation manifest");
        assert_eq!(fs::read(&manifest).unwrap(), bytes);
        assert!(global.join("skill-install.lock").exists());
        assert!(!home.join(".claude/skills/tmux-team").exists());
        assert!(!global.join("skill-assets").exists());
    }
}

#[test]
fn installer_error_releases_lock_for_a_following_success() {
    let (_directory, environment, global, home) = fixture();
    let target = home.join(".claude/skills/tmux-team");
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    fs::write(&target, b"user-owned").unwrap();
    let failure = install(&environment, &global, Some("claude"), None, false).unwrap_err();
    assert_failure_preserves(&failure, "Refusing to replace existing unmanaged path");
    fs::remove_file(&target).unwrap();
    let success = install(&environment, &global, Some("claude"), None, false).unwrap();
    assert!(success.installed[0].changed);
    assert!(fs::symlink_metadata(&target).unwrap().is_symlink());
}

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[test]
fn valid_old_digest_source_refreshes_to_current_source_without_backup() {
    let (_directory, environment, global, home) = fixture();
    let old = b"old canonical skill\n";
    let asset_root = super::files::resolved(&global)
        .unwrap()
        .join("skill-assets");
    let old_source = asset_root.join(digest(old)).join("tmux-team");
    fs::create_dir_all(&old_source).unwrap();
    fs::write(old_source.join("SKILL.md"), old).unwrap();
    let target = home.join(".claude/skills/tmux-team");
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&old_source, &target).unwrap();

    let report = install(&environment, &global, Some("claude"), None, false).unwrap();
    assert!(report.installed[0].changed);
    assert_eq!(report.installed[0].backup, None);
    let current = assert_link(&target);
    assert_ne!(current, old_source);
    assert_eq!(fs::read(current.join("SKILL.md")).unwrap(), bundled_skill());
    assert_eq!(fs::read(old_source.join("SKILL.md")).unwrap(), old);
}

#[test]
fn modified_old_digest_source_is_unmanaged_and_refuses_replacement() {
    let (_directory, environment, global, home) = fixture();
    let original = b"old canonical skill\n";
    let modified = b"tampered old skill\n";
    let old_source = super::files::resolved(&global)
        .unwrap()
        .join("skill-assets")
        .join(digest(original))
        .join("tmux-team");
    fs::create_dir_all(&old_source).unwrap();
    fs::write(old_source.join("SKILL.md"), modified).unwrap();
    let target = home.join(".claude/skills/tmux-team");
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&old_source, &target).unwrap();

    let failure = install(&environment, &global, Some("claude"), None, false).unwrap_err();
    assert_failure_preserves(&failure, "Refusing to replace existing unmanaged path");
    assert_eq!(fs::read_link(&target).unwrap(), old_source);
    assert_eq!(fs::read(old_source.join("SKILL.md")).unwrap(), modified);
    let forced = install(&environment, &global, Some("claude"), None, true).unwrap();
    let backup = forced.installed[0].backup.as_ref().unwrap();
    assert_eq!(fs::read_link(backup).unwrap(), old_source);
    assert_eq!(fs::read(old_source.join("SKILL.md")).unwrap(), modified);
    assert_eq!(fs::read(target.join("SKILL.md")).unwrap(), bundled_skill());
}

#[test]
fn modified_current_asset_blocks_force_before_target_backup() {
    let (_directory, env, global, home) = fixture();
    install(&env, &global, Some("claude"), None, false).unwrap();
    let target = home.join(".claude/skills/tmux-team");
    let source = assert_link(&target);
    fs::write(source.join("SKILL.md"), b"user-edited current source").unwrap();
    let failure = install(&env, &global, Some("claude"), None, true).unwrap_err();
    assert_failure_preserves(&failure, "Managed skill source has been modified");
    assert_eq!(assert_link(&target), source);
    assert_eq!(
        fs::read(source.join("SKILL.md")).unwrap(),
        b"user-edited current source"
    );
    assert!(!home.join(".claude/.tmt-skill-backups").exists());
}
