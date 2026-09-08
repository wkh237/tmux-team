use super::{bundled_skill, files, refresh, registry};
use crate::{content_digest::sha256, test_support::TestDirectory};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

fn fixture() -> (TestDirectory, PathBuf) {
    let directory = TestDirectory::new();
    let global = directory.path.join("global");
    (directory, global)
}

fn old_source(global: &Path, bytes: &[u8]) -> PathBuf {
    let root = files::resolved(global).unwrap().join("skill-assets");
    let source = root.join(sha256(bytes)).join("tmux-team");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("SKILL.md"), bytes).unwrap();
    source
}

fn managed_target(target: &Path, source: &Path) {
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(source, target).unwrap();
}

fn remember(global: &Path, targets: impl IntoIterator<Item = PathBuf>) {
    registry::remember(global, targets).unwrap();
}

fn target_paths(root: &Path) -> [PathBuf; 3] {
    [
        root.join("home/.claude/skills/tmux-team"),
        root.join("home/.agents/skills/tmux-team"),
        root.join("workspace/custom/tmux-team"),
    ]
}

fn assert_current(target: &Path) {
    let source = fs::read_link(target).unwrap();
    assert_eq!(fs::read(source.join("SKILL.md")).unwrap(), bundled_skill());
}

#[test]
fn refreshes_old_owned_source_and_repeat_is_an_exact_byte_noop() {
    let (directory, global) = fixture();
    let old = b"old canonical skill\n";
    let source = old_source(&global, old);
    let target = directory.path.join("home/.claude/skills/tmux-team");
    managed_target(&target, &source);
    remember(&global, [target.clone()]);
    let manifest_before = fs::read(global.join("skill-installations.json")).unwrap();

    let first = refresh(&global).unwrap();
    assert_eq!(first.skipped, Vec::<PathBuf>::new());
    assert_eq!(first.conflicts, Vec::<PathBuf>::new());
    assert_eq!(first.refreshed.len(), 1);
    assert_eq!(first.refreshed[0].target, target);
    assert!(first.refreshed[0].changed);
    assert_current(&target);
    assert_ne!(old.as_slice(), bundled_skill());
    assert_eq!(fs::read(source.join("SKILL.md")).unwrap(), old);
    assert!(
        !directory
            .path
            .join("home/.claude/.tmt-skill-backups")
            .exists()
    );

    let second = refresh(&global).unwrap();
    assert_eq!(second.refreshed.len(), 1);
    assert!(!second.refreshed[0].changed);
    assert_eq!(second.skipped, Vec::<PathBuf>::new());
    assert_eq!(second.conflicts, Vec::<PathBuf>::new());
    assert_eq!(
        fs::read(global.join("skill-installations.json")).unwrap(),
        manifest_before
    );
    assert_current(&target);
}

#[test]
fn refreshes_multiple_provider_and_custom_targets_without_discovery() {
    let (directory, global) = fixture();
    let old = b"old provider skill\n";
    let source = old_source(&global, old);
    let targets = target_paths(&directory.path);
    for target in &targets {
        managed_target(target, &source);
    }
    remember(&global, targets.iter().cloned());

    let report = refresh(&global).unwrap();
    assert_eq!(report.refreshed.len(), targets.len());
    assert!(report.refreshed.iter().all(|item| item.changed));
    for target in targets {
        assert_current(&target);
    }
}

#[test]
fn missing_or_empty_registry_does_not_create_filesystem_state() {
    let (directory, missing_global) = fixture();
    assert!(!missing_global.exists());
    let missing = refresh(&missing_global).unwrap();
    assert!(missing.refreshed.is_empty());
    assert!(missing.skipped.is_empty());
    assert!(missing.conflicts.is_empty());
    assert!(!missing_global.exists());

    let empty_global = directory.path.join("empty-global");
    fs::create_dir(&empty_global).unwrap();
    let manifest = empty_global.join("skill-installations.json");
    fs::write(&manifest, br#"{"version":1,"targets":[]}"#).unwrap();
    let before = fs::read_dir(&empty_global)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();

    let empty = refresh(&empty_global).unwrap();
    assert!(empty.refreshed.is_empty());
    assert!(empty.skipped.is_empty());
    assert!(empty.conflicts.is_empty());
    assert_eq!(
        fs::read_dir(&empty_global)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>(),
        before
    );
    assert_eq!(
        fs::read(&manifest).unwrap(),
        br#"{"version":1,"targets":[]}"#
    );
    assert!(!empty_global.join("skill-assets").exists());
    assert!(!empty_global.join("skill-install.lock").exists());
}

#[test]
fn missing_recorded_target_is_skipped_without_resurrection() {
    let (_directory, global) = fixture();
    let target = global
        .parent()
        .unwrap()
        .join("deleted/.agents/skills/tmux-team");
    remember(&global, [target.clone()]);

    let report = refresh(&global).unwrap();
    assert!(report.refreshed.is_empty());
    assert_eq!(report.skipped, vec![target.clone()]);
    assert!(report.conflicts.is_empty());
    assert!(!target.exists());
    assert!(!global.join("skill-assets").exists());
}

#[test]
fn conflicts_are_preserved_while_independent_targets_refresh() {
    let (directory, global) = fixture();
    let old = b"old canonical skill\n";
    let modified_source = old_source(&global, old);
    fs::write(modified_source.join("SKILL.md"), b"user-modified source\n").unwrap();
    let modified_target = directory.path.join("home/.claude/skills/tmux-team");
    managed_target(&modified_target, &modified_source);
    let unmanaged_target = directory.path.join("home/.agents/skills/tmux-team");
    fs::create_dir_all(unmanaged_target.parent().unwrap()).unwrap();
    fs::write(&unmanaged_target, b"user-owned target\n").unwrap();
    let good_target = directory.path.join("workspace/custom/tmux-team");
    let good_source = old_source(&global, b"another old skill\n");
    managed_target(&good_target, &good_source);
    remember(
        &global,
        [
            modified_target.clone(),
            unmanaged_target.clone(),
            good_target.clone(),
        ],
    );

    let failure = refresh(&global).unwrap_err();
    assert_eq!(failure.report.refreshed.len(), 1);
    assert_eq!(failure.report.refreshed[0].target, good_target);
    assert!(failure.report.refreshed[0].changed);
    assert_eq!(
        failure.report.conflicts,
        vec![unmanaged_target.clone(), modified_target.clone()]
    );
    assert!(failure.report.skipped.is_empty());
    assert_current(&good_target);
    assert_eq!(
        fs::read(modified_source.join("SKILL.md")).unwrap(),
        b"user-modified source\n"
    );
    assert_eq!(fs::read(&unmanaged_target).unwrap(), b"user-owned target\n");
    assert!(
        !directory
            .path
            .join("home/.claude/.tmt-skill-backups")
            .exists()
    );
}

#[test]
fn duplicate_registry_intents_publish_once() {
    let (directory, global) = fixture();
    let old = b"old canonical skill\n";
    let source = old_source(&global, old);
    let target = directory.path.join("home/.claude/skills/tmux-team");
    managed_target(&target, &source);
    let manifest = global.join("skill-installations.json");
    fs::create_dir_all(&global).unwrap();
    fs::write(
        &manifest,
        serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "targets": [target.to_str().unwrap(), target.to_str().unwrap()]
        }))
        .unwrap(),
    )
    .unwrap();
    let mut publications = 0;
    let report = super::refresh::refresh_with_publisher(&global, |actual, source| {
        publications += 1;
        files::link(actual, source)
    })
    .unwrap();
    assert_eq!(publications, 1);
    assert_eq!(report.refreshed.len(), 1);
    assert_current(&target);
}

#[test]
fn invalid_or_symlink_registry_is_rejected_without_mutation() {
    let (directory, global) = fixture();
    fs::create_dir_all(&global).unwrap();
    let manifest = global.join("skill-installations.json");
    let invalid = br#"{"version":2,"targets":[]}"#;
    fs::write(&manifest, invalid).unwrap();
    let failure = refresh(&global).unwrap_err();
    assert!(
        failure
            .to_string()
            .contains("Invalid or oversized skill installation manifest")
    );
    assert!(failure.report.refreshed.is_empty());
    assert_eq!(fs::read(&manifest).unwrap(), invalid);
    assert!(!global.join("skill-install.lock").exists());
    assert!(!global.join("skill-assets").exists());

    fs::remove_file(&manifest).unwrap();
    let external = directory.path.join("external.json");
    let external_bytes = br#"{"version":1,"targets":[]}"#;
    fs::write(&external, external_bytes).unwrap();
    std::os::unix::fs::symlink(&external, &manifest).unwrap();
    let failure = refresh(&global).unwrap_err();
    assert!(
        failure
            .to_string()
            .contains("Invalid or oversized skill installation manifest")
    );
    assert!(failure.report.refreshed.is_empty());
    assert_eq!(fs::read_link(&manifest).unwrap(), external);
    assert_eq!(fs::read(&external).unwrap(), external_bytes);
    assert!(!global.join("skill-install.lock").exists());
    assert!(!global.join("skill-assets").exists());
}

#[test]
fn held_lock_rejects_refresh_without_materializing_assets() {
    let (directory, global) = fixture();
    let target = directory.path.join("home/.claude/skills/tmux-team");
    remember(&global, [target.clone()]);
    let lock = files::lock(&global).unwrap();

    let failure = refresh(&global).unwrap_err();
    assert!(failure.report.refreshed.is_empty());
    assert!(failure.report.skipped.is_empty());
    assert!(failure.report.conflicts.is_empty());
    assert!(failure.to_string().contains("Cannot acquire"));
    assert!(!target.exists());
    assert!(!global.join("skill-assets").exists());
    drop(lock);
}

#[test]
fn later_publication_failure_preserves_prior_bytes_and_retry_reuses_owner() {
    let (directory, global) = fixture();
    let old = b"old canonical skill\n";
    let source = old_source(&global, old);
    let first = directory.path.join("home/.claude/skills/first/tmux-team");
    let second = directory.path.join("home/.agents/skills/second/tmux-team");
    managed_target(&first, &source);
    managed_target(&second, &source);
    remember(&global, [first.clone(), second.clone()]);

    let mut publications = 0;
    let failure = super::refresh::refresh_with_publisher(&global, |target, source| {
        publications += 1;
        if publications == 2 {
            return Err(io::Error::other("injected second publication failure"));
        }
        files::link(target, source)
    })
    .unwrap_err();
    assert_eq!(publications, 2);
    assert!(
        failure
            .to_string()
            .contains("injected second publication failure")
    );
    assert_eq!(failure.report.refreshed.len(), 1);
    assert_eq!(failure.report.refreshed[0].target, second);
    assert_current(&second);
    assert_eq!(fs::read_link(&first).unwrap(), source);
    assert_eq!(fs::read(source.join("SKILL.md")).unwrap(), old);

    let retry = refresh(&global).unwrap();
    assert_eq!(retry.refreshed.len(), 2);
    assert!(
        !retry
            .refreshed
            .iter()
            .find(|item| item.target == second)
            .unwrap()
            .changed
    );
    assert!(
        retry
            .refreshed
            .iter()
            .find(|item| item.target == first)
            .unwrap()
            .changed
    );
    assert_current(&first);
    assert_current(&second);
}

#[test]
fn alias_intents_share_one_observed_target_without_rewriting_the_registry() {
    let (directory, global) = fixture();
    let source = old_source(&global, b"old alias fixture\n");
    let parent = directory.path.join("actual-skills");
    let target = parent.join("tmux-team");
    managed_target(&target, &source);
    let alias = directory.path.join("alias-skills");
    std::os::unix::fs::symlink(&parent, &alias).unwrap();
    remember(&global, [target.clone(), alias.join("tmux-team")]);
    let registry_before = fs::read(global.join("skill-installations.json")).unwrap();
    let mut publications = 0;
    let report = super::refresh::refresh_with_publisher(&global, |target, source| {
        publications += 1;
        files::link(target, source)
    })
    .unwrap();
    assert_eq!(publications, 1);
    assert_eq!(report.refreshed.len(), 1);
    assert_current(&target);
    assert_eq!(
        fs::read(global.join("skill-installations.json")).unwrap(),
        registry_before
    );
}
