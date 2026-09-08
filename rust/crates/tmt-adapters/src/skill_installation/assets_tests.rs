use super::assets::{SKILL, SkillAssets};
use crate::test_support::TestDirectory;
use std::fs;

#[test]
fn materialized_source_is_exact_and_repeated_install_preserves_it() {
    let root = TestDirectory::new();
    let assets = SkillAssets::new(&root.path);
    let source = assets.materialize().unwrap();
    assert_eq!(fs::read(source.join("SKILL.md")).unwrap(), SKILL);
    assert!(assets.owns(&source));
    assert_eq!(assets.materialize().unwrap(), source);
    assert_eq!(
        fs::read_dir(root.path.join("skill-assets"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn modified_or_extended_source_is_neither_overwritten_nor_trusted() {
    for extra in [false, true] {
        let root = TestDirectory::new();
        let assets = SkillAssets::new(&root.path);
        let source = assets.materialize().unwrap();
        let changed = source.join(if extra { "unexpected.md" } else { "SKILL.md" });
        fs::write(&changed, b"user-owned content").unwrap();
        assert!(!assets.owns(&source));
        assert!(assets.materialize().is_err());
        assert_eq!(fs::read(changed).unwrap(), b"user-owned content");
        assert_eq!(
            fs::read_dir(root.path.join("skill-assets"))
                .unwrap()
                .count(),
            1
        );
    }
}

#[test]
fn occupied_digest_path_is_preserved_and_failed_staging_is_removed() {
    let root = TestDirectory::new();
    let assets = SkillAssets::new(&root.path);
    let occupied = assets.source().parent().unwrap().to_path_buf();
    fs::create_dir_all(occupied.parent().unwrap()).unwrap();
    fs::write(&occupied, b"unrelated file").unwrap();
    assert!(assets.materialize().is_err());
    assert_eq!(fs::read(&occupied).unwrap(), b"unrelated file");
    assert_eq!(fs::read_dir(occupied.parent().unwrap()).unwrap().count(), 1);
}

#[test]
fn external_source_and_symlinked_skill_file_never_establish_managed_ownership() {
    use std::os::unix::fs::symlink;
    let root = TestDirectory::new();
    let assets = SkillAssets::new(&root.path);
    let source = assets.materialize().unwrap();
    let external = root.path.join("outside");
    fs::create_dir(&external).unwrap();
    fs::write(external.join("SKILL.md"), SKILL).unwrap();
    assert!(!assets.owns(&external));
    fs::remove_file(source.join("SKILL.md")).unwrap();
    symlink(external.join("SKILL.md"), source.join("SKILL.md")).unwrap();
    assert!(!assets.owns(&source));
    assert!(assets.materialize().is_err());
    assert_eq!(fs::read(external.join("SKILL.md")).unwrap(), SKILL);
}

#[test]
fn symlinked_digest_directory_is_not_a_managed_source() {
    let root = TestDirectory::new();
    let assets = SkillAssets::new(&root.path);
    let source = assets.materialize().unwrap();
    let version = source.parent().unwrap();
    let outside = root.path.join("external-version");
    fs::rename(version, &outside).unwrap();
    std::os::unix::fs::symlink(&outside, version).unwrap();
    assert!(!assets.owns(&source));
    assert!(assets.materialize().is_err());
    assert_eq!(fs::read(outside.join("tmux-team/SKILL.md")).unwrap(), SKILL);
    assert_eq!(fs::read_link(version).unwrap(), outside);
}
