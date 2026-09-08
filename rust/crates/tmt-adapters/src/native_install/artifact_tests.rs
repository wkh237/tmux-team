use super::artifact::{self, FILES};
use crate::test_support::TestDirectory;
use flate2::{Compression, write::GzEncoder};
use serde_json::json;
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{self, Read},
    path::PathBuf,
};
use tar::{Builder, EntryType, Header};

const TARGET: &str = "aarch64-apple-darwin";

enum Entry {
    File {
        path: String,
        bytes: Vec<u8>,
        mode: u32,
    },
    AdversarialFile {
        path: String,
        bytes: Vec<u8>,
        mode: u32,
    },
    Symlink {
        path: String,
        target: String,
    },
}

struct Fixture {
    directory: TestDirectory,
    manifest: PathBuf,
    archive: PathBuf,
    name: String,
}

fn valid_entries(root: &str) -> Vec<Entry> {
    vec![
        Entry::File {
            path: format!("{root}/tmt"),
            bytes: b"native executable\n".to_vec(),
            mode: 0o755,
        },
        Entry::File {
            path: format!("{root}/LICENSE"),
            bytes: b"MIT\n".to_vec(),
            mode: 0o644,
        },
        Entry::File {
            path: format!("{root}/NATIVE-INSTALL.md"),
            bytes: "Native install\n".as_bytes().to_vec(),
            mode: 0o644,
        },
        Entry::File {
            path: format!("{root}/THIRD-PARTY-NOTICES.txt"),
            bytes: b"Third-party notices\n".to_vec(),
            mode: 0o644,
        },
    ]
}

fn append_entry(builder: &mut Builder<GzEncoder<Vec<u8>>>, entry: Entry) {
    match entry {
        Entry::File { path, bytes, mode } => {
            let mut header = Header::new_gnu();
            header.set_path(path).unwrap();
            header.set_entry_type(EntryType::Regular);
            header.set_mode(mode);
            header.set_size(bytes.len() as u64);
            header.set_cksum();
            builder.append(&header, bytes.as_slice()).unwrap();
        }
        Entry::AdversarialFile { path, bytes, mode } => {
            let mut header = Header::new_gnu();
            header.set_path("safe-placeholder").unwrap();
            header.set_entry_type(EntryType::Regular);
            header.set_mode(mode);
            header.set_size(bytes.len() as u64);
            assert!(path.is_ascii() && path.len() <= 100);
            // Bypass tar::Header::set_path only to create a valid checksum-bearing archive with
            // a traversal name; production decode must reject it before any extraction.
            let raw = header.as_mut_bytes();
            raw[..100].fill(0);
            raw[..path.len()].copy_from_slice(path.as_bytes());
            header.set_cksum();
            builder.append(&header, bytes.as_slice()).unwrap();
        }
        Entry::Symlink { path, target } => {
            let mut header = Header::new_gnu();
            header.set_path(path).unwrap();
            header.set_entry_type(EntryType::Symlink);
            header.set_mode(0o777);
            header.set_size(0);
            header.set_link_name(target).unwrap();
            header.set_cksum();
            builder.append(&header, &[][..]).unwrap();
        }
    }
}

fn gzip_tar(entries: Vec<Entry>) -> Vec<u8> {
    let encoder = GzEncoder::new(Vec::new(), Compression::default());
    let mut builder = Builder::new(encoder);
    for entry in entries {
        append_entry(&mut builder, entry);
    }
    builder.finish().unwrap();
    builder.into_inner().unwrap().finish().unwrap()
}

fn fixture(entries: Vec<Entry>) -> Fixture {
    let directory = TestDirectory::new();
    let name = "tmux-team-1.2.3-aarch64-apple-darwin.tar.gz".to_owned();
    let archive = directory.path.join(&name);
    let manifest = directory.path.join("manifest.json");
    let compressed = gzip_tar(entries);
    let checksum = artifact::digest(&compressed);
    fs::write(&archive, compressed).unwrap();
    fs::write(
        &manifest,
        serde_json::to_vec(&json!({
            "artifacts": {
                name.clone(): {
                    "kind": "executable-zip",
                    "name": name.clone(),
                    "target_triples": [TARGET],
                    "checksums": {"sha256": checksum},
                    "assets": FILES.iter().map(|path| json!({"path": path})).collect::<Vec<_>>(),
                }
            },
            "releases": [{
                "app_name": "tmt-cli",
                "app_version": "1.2.3",
                "artifacts": [name.clone()]
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    Fixture {
        directory,
        manifest,
        archive,
        name,
    }
}

fn replace_archive(fixture: &Fixture, compressed: &[u8]) {
    fs::write(&fixture.archive, compressed).unwrap();
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&fixture.manifest).unwrap()).unwrap();
    manifest["artifacts"][fixture.name.clone()]["checksums"]["sha256"] =
        json!(artifact::digest(compressed));
    fs::write(&fixture.manifest, serde_json::to_vec(&manifest).unwrap()).unwrap();
}

fn file_map(entries: &[(&str, &[u8])]) -> BTreeMap<String, Vec<u8>> {
    entries
        .iter()
        .map(|(name, bytes)| ((*name).to_owned(), bytes.to_vec()))
        .collect()
}

fn root_entries(directory: &TestDirectory) -> Vec<String> {
    let mut entries = fs::read_dir(&directory.path)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    entries.sort();
    entries
}

fn assert_only_inputs_remain(fixture: &Fixture) {
    let mut expected = vec![fixture.name.clone(), "manifest.json".to_owned()];
    expected.sort();
    assert_eq!(root_entries(&fixture.directory), expected);
}

#[test]
fn acquire_returns_exact_metadata_and_payload_without_extracting_files() {
    let fixture = fixture(valid_entries("tmux-team-1.2.3-aarch64-apple-darwin"));
    let artifact = artifact::acquire(&fixture.manifest, &fixture.archive, TARGET).unwrap();
    assert_eq!(artifact.name, fixture.name);
    assert_eq!(artifact.version, semver::Version::new(1, 2, 3));
    assert_eq!(artifact.target, TARGET);
    assert_eq!(artifact.sha256.len(), 64);
    assert_eq!(
        artifact.files,
        file_map(&[
            ("tmt", b"native executable\n"),
            ("LICENSE", b"MIT\n"),
            ("NATIVE-INSTALL.md", b"Native install\n"),
            ("THIRD-PARTY-NOTICES.txt", b"Third-party notices\n"),
        ])
    );
    assert_only_inputs_remain(&fixture);
}

#[test]
fn corrupt_checksum_and_wrong_target_are_rejected_before_archive_processing() {
    let checksum_fixture = fixture(valid_entries("tmux-team-1.2.3-aarch64-apple-darwin"));
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&checksum_fixture.manifest).unwrap()).unwrap();
    let name = checksum_fixture.name.clone();
    manifest["artifacts"][name]["checksums"]["sha256"] = json!("0".repeat(64));
    fs::write(
        &checksum_fixture.manifest,
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    let error = artifact::acquire(
        &checksum_fixture.manifest,
        &checksum_fixture.archive,
        TARGET,
    )
    .unwrap_err();
    assert_eq!(error.to_string(), "Native archive checksum mismatch.");
    assert_only_inputs_remain(&checksum_fixture);

    let target_fixture = fixture(valid_entries("tmux-team-1.2.3-aarch64-apple-darwin"));
    let error = artifact::acquire(
        &target_fixture.manifest,
        &target_fixture.archive,
        "x86_64-unknown-linux-musl",
    )
    .unwrap_err();
    assert_eq!(
        error.to_string(),
        "Native archive metadata or target does not match."
    );
    assert_only_inputs_remain(&target_fixture);
}

#[test]
fn duplicate_and_missing_required_entries_are_rejected() {
    let root = "tmux-team-1.2.3-aarch64-apple-darwin";
    let mut duplicate = valid_entries(root);
    duplicate.push(Entry::File {
        path: format!("{root}/tmt"),
        bytes: b"duplicate\n".to_vec(),
        mode: 0o755,
    });
    let duplicate_fixture = fixture(duplicate);
    let error = artifact::acquire(
        &duplicate_fixture.manifest,
        &duplicate_fixture.archive,
        TARGET,
    )
    .unwrap_err();
    assert_eq!(error.to_string(), "Duplicate native archive file.");
    assert_only_inputs_remain(&duplicate_fixture);

    let mut missing = valid_entries(root);
    missing
        .retain(|entry| !matches!(entry, Entry::File { path, .. } if path.ends_with("/LICENSE")));
    let missing_fixture = fixture(missing);
    let error =
        artifact::acquire(&missing_fixture.manifest, &missing_fixture.archive, TARGET).unwrap_err();
    assert_eq!(
        error.to_string(),
        "Native archive is missing required files."
    );
    assert_only_inputs_remain(&missing_fixture);
}

#[test]
fn symlink_path_traversal_and_special_permissions_are_rejected() {
    let root = "tmux-team-1.2.3-aarch64-apple-darwin";
    let mut symlink = valid_entries(root);
    symlink[0] = Entry::Symlink {
        path: format!("{root}/tmt"),
        target: "outside".to_owned(),
    };
    let symlink_fixture = fixture(symlink);
    let error =
        artifact::acquire(&symlink_fixture.manifest, &symlink_fixture.archive, TARGET).unwrap_err();
    assert_eq!(
        error.to_string(),
        "Native archive requires nonempty regular files with safe permissions."
    );
    assert_only_inputs_remain(&symlink_fixture);

    let traversal = vec![Entry::AdversarialFile {
        path: format!("{root}/../escape"),
        bytes: b"escape\n".to_vec(),
        mode: 0o644,
    }];
    let traversal_fixture = fixture(traversal);
    let error = artifact::acquire(
        &traversal_fixture.manifest,
        &traversal_fixture.archive,
        TARGET,
    )
    .unwrap_err();
    assert_eq!(error.to_string(), "Unexpected native archive path.");
    assert_only_inputs_remain(&traversal_fixture);

    let mut special = valid_entries(root);
    special[0] = Entry::File {
        path: format!("{root}/tmt"),
        bytes: b"native executable\n".to_vec(),
        mode: 0o4755,
    };
    let special_fixture = fixture(special);
    let error =
        artifact::acquire(&special_fixture.manifest, &special_fixture.archive, TARGET).unwrap_err();
    assert_eq!(
        error.to_string(),
        "Native archive requires nonempty regular files with safe permissions."
    );
    assert_only_inputs_remain(&special_fixture);
}

#[test]
fn rejects_empty_and_non_executable_required_files() {
    let root = "tmux-team-1.2.3-aarch64-apple-darwin";
    let mut empty = valid_entries(root);
    empty[0] = Entry::File {
        path: format!("{root}/tmt"),
        bytes: Vec::new(),
        mode: 0o755,
    };
    let empty_fixture = fixture(empty);
    let error =
        artifact::acquire(&empty_fixture.manifest, &empty_fixture.archive, TARGET).unwrap_err();
    assert_eq!(
        error.to_string(),
        "Native archive requires nonempty regular files with safe permissions."
    );
    assert_only_inputs_remain(&empty_fixture);

    let mut non_executable = valid_entries(root);
    non_executable[0] = Entry::File {
        path: format!("{root}/tmt"),
        bytes: b"native executable\n".to_vec(),
        mode: 0o644,
    };
    let non_executable_fixture = fixture(non_executable);
    let error = artifact::acquire(
        &non_executable_fixture.manifest,
        &non_executable_fixture.archive,
        TARGET,
    )
    .unwrap_err();
    assert_eq!(
        error.to_string(),
        "Native archive requires nonempty regular files with safe permissions."
    );
    assert_only_inputs_remain(&non_executable_fixture);
}

#[test]
fn rejects_truncated_archive_after_checksum_verification() {
    let fixture = fixture(valid_entries("tmux-team-1.2.3-aarch64-apple-darwin"));
    let mut truncated = fs::read(&fixture.archive).unwrap();
    truncated.truncate(truncated.len() - 8);
    replace_archive(&fixture, &truncated);
    let error = artifact::acquire(&fixture.manifest, &fixture.archive, TARGET).unwrap_err();
    assert_eq!(error.to_string(), "unexpected end of file");
    assert_only_inputs_remain(&fixture);
}

#[test]
fn rejects_compressed_archive_above_the_bound_before_checksum() {
    let fixture = fixture(valid_entries("tmux-team-1.2.3-aarch64-apple-darwin"));
    OpenOptions::new()
        .write(true)
        .open(&fixture.archive)
        .unwrap()
        .set_len((64 * 1024 * 1024 + 1) as u64)
        .unwrap();
    let error = artifact::acquire(&fixture.manifest, &fixture.archive, TARGET).unwrap_err();
    assert_eq!(error.to_string(), "File exceeds the input bound.");
    assert_only_inputs_remain(&fixture);
}

#[test]
fn rejects_expanded_archive_above_the_bound_before_tar_parsing() {
    let fixture = fixture(valid_entries("tmux-team-1.2.3-aarch64-apple-darwin"));
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    let mut source = io::repeat(0).take((128 * 1024 * 1024 + 1) as u64);
    io::copy(&mut source, &mut encoder).unwrap();
    let compressed = encoder.finish().unwrap();
    assert!(compressed.len() < 64 * 1024 * 1024);
    replace_archive(&fixture, &compressed);
    let error = artifact::acquire(&fixture.manifest, &fixture.archive, TARGET).unwrap_err();
    assert_eq!(
        error.to_string(),
        "Native archive expansion exceeds its bound."
    );
    assert_only_inputs_remain(&fixture);
}

#[test]
fn malformed_manifest_is_rejected_without_touching_archive_or_extracting() {
    let fixture = fixture(valid_entries("tmux-team-1.2.3-aarch64-apple-darwin"));
    let original_archive = fs::read(&fixture.archive).unwrap();
    fs::write(&fixture.manifest, b"{ malformed").unwrap();
    assert!(artifact::acquire(&fixture.manifest, &fixture.archive, TARGET).is_err());
    assert_eq!(fs::read(&fixture.archive).unwrap(), original_archive);
    assert_only_inputs_remain(&fixture);
}
