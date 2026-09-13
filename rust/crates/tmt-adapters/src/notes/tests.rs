use super::*;
use crate::test_support::TestDirectory;
use std::{
    fs,
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    sync::{Arc, Barrier},
    thread,
};
use tmt_core::identity::{Identity, Lifetime, NotesIdentityId};

fn identity_id() -> NotesIdentityId {
    NotesIdentityId::try_from(&Identity {
        id: "e27f6cd2-2ce7-4c40-8ef7-f156492e983b".into(),
        name: "Researcher".into(),
        canonical_name: "researcher".into(),
        lifetime: Lifetime::Saved,
        created_at: String::new(),
        updated_at: String::new(),
    })
    .unwrap()
}

fn paths(directory: &TestDirectory) -> ConfigPaths {
    ConfigPaths::resolve(
        &directory.path,
        &directory.path,
        Some(&directory.path.join("config")),
        None,
    )
}

#[test]
fn creates_private_empty_file_and_preserves_existing_bytes_and_inode() {
    let directory = TestDirectory::new();
    let paths = paths(&directory);
    fs::create_dir(&paths.global_dir).unwrap();

    let first = initialize(&paths, &identity_id()).unwrap();
    assert!(first.created);
    assert!(first.path.is_absolute());
    assert_eq!(fs::read(&first.path).unwrap(), b"");
    let identity_dir = first.path.parent().unwrap();
    let notes_dir = identity_dir.parent().unwrap();
    assert_eq!(
        fs::metadata(identity_dir).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(notes_dir).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(&first.path).unwrap().permissions().mode() & 0o777,
        0o600
    );

    fs::write(&first.path, b"# Notes\nexact bytes\0\xff").unwrap();
    let before = fs::metadata(&first.path).unwrap().ino();
    let second = initialize(&paths, &identity_id()).unwrap();
    assert!(!second.created);
    assert_eq!(second.path, first.path);
    assert_eq!(fs::metadata(&second.path).unwrap().ino(), before);
    assert_eq!(
        fs::read(&second.path).unwrap(),
        b"# Notes\nexact bytes\0\xff"
    );
}

#[test]
fn concurrent_first_access_has_one_creator() {
    let directory = TestDirectory::new();
    let paths = paths(&directory);
    fs::create_dir(&paths.global_dir).unwrap();
    let barrier = Arc::new(Barrier::new(8));
    let handles = (0..8)
        .map(|_| {
            let paths = paths.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                initialize(&paths, &identity_id()).unwrap()
            })
        })
        .collect::<Vec<_>>();
    let reports = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(reports.iter().filter(|report| report.created).count(), 1);
    assert!(reports.windows(2).all(|pair| pair[0].path == pair[1].path));

    let notes_file = &reports[0].path;
    assert!(fs::symlink_metadata(notes_file).unwrap().is_file());
    assert_eq!(fs::read(notes_file).unwrap(), b"");
    fs::write(notes_file, b"# concurrent sentinel\n").unwrap();
    let inode = fs::metadata(notes_file).unwrap().ino();
    let repeat_barrier = Arc::new(Barrier::new(8));
    let repeats = (0..8)
        .map(|_| {
            let paths = paths.clone();
            let barrier = repeat_barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                initialize(&paths, &identity_id()).unwrap()
            })
        })
        .collect::<Vec<_>>()
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect::<Vec<_>>();
    assert!(repeats.iter().all(|report| !report.created));
    assert!(repeats.iter().all(|report| report.path == *notes_file));
    assert_eq!(fs::metadata(notes_file).unwrap().ino(), inode);
    assert_eq!(fs::read(notes_file).unwrap(), b"# concurrent sentinel\n");
}

#[test]
fn rejects_symlink_and_nonregular_targets_without_touching_them() {
    let directory = TestDirectory::new();
    let paths = paths(&directory);
    fs::create_dir(&paths.global_dir).unwrap();
    let notes = paths.global_dir.join("notes");
    let outside = directory.path.join("outside");
    fs::create_dir(&outside).unwrap();
    let sentinel = outside.join("sentinel");
    fs::write(&sentinel, b"untouched").unwrap();
    symlink(&outside, &notes).unwrap();
    assert!(initialize(&paths, &identity_id()).is_err());
    assert_eq!(fs::read(&sentinel).unwrap(), b"untouched");

    fs::remove_file(&notes).unwrap();
    fs::create_dir(&notes).unwrap();
    let identity_dir = notes.join(identity_id().as_str());
    symlink(&outside, &identity_dir).unwrap();
    assert!(initialize(&paths, &identity_id()).is_err());
    assert_eq!(fs::read(&sentinel).unwrap(), b"untouched");
    assert!(!outside.join("notes.md").exists());

    fs::remove_file(&identity_dir).unwrap();
    fs::create_dir(&identity_dir).unwrap();
    let notes_file = identity_dir.join("notes.md");
    symlink(&sentinel, &notes_file).unwrap();
    assert!(initialize(&paths, &identity_id()).is_err());
    assert_eq!(fs::read(&sentinel).unwrap(), b"untouched");

    fs::remove_file(&notes_file).unwrap();
    let missing = outside.join("missing.md");
    symlink(&missing, &notes_file).unwrap();
    assert!(initialize(&paths, &identity_id()).is_err());
    assert!(!missing.exists());

    fs::remove_file(&notes_file).unwrap();
    fs::create_dir(&notes_file).unwrap();
    assert!(initialize(&paths, &identity_id()).is_err());
}
