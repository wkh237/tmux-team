//! Cargo-dist metadata and bounded, allowlisted archive acquisition.
//!
//! Never use generic archive unpacking: archive paths are not filesystem targets.

use super::invalid;
use crate::bounded_file;
pub(super) use crate::content_digest::sha256 as digest;
use flate2::read::MultiGzDecoder;
use semver::Version;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    io::{self, Read},
    path::Path,
};

pub(super) const COMPRESSED_LIMIT: usize = 64 * 1024 * 1024;
pub(super) const MANIFEST_LIMIT: usize = 4 * 1024 * 1024;
const EXPANDED_LIMIT: usize = 128 * 1024 * 1024;
pub(super) const FILES: [&str; 4] = [
    "tmt",
    "LICENSE",
    "NATIVE-INSTALL.md",
    "THIRD-PARTY-NOTICES.txt",
];

#[derive(Debug)]
pub(super) struct Artifact {
    pub name: String,
    pub version: Version,
    pub target: String,
    pub sha256: String,
    pub files: BTreeMap<String, Vec<u8>>,
}

impl Artifact {
    pub fn file_hashes(&self) -> BTreeMap<String, String> {
        self.files
            .iter()
            .map(|(name, bytes)| (name.clone(), digest(bytes)))
            .collect()
    }
}

pub(super) fn acquire(manifest: &Path, archive: &Path, target: &str) -> io::Result<Artifact> {
    let bytes = bounded_file::read_no_follow(manifest, MANIFEST_LIMIT).map_err(io::Error::other)?;
    let manifest: Value = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
    let name = archive
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| invalid("Native archive requires an ASCII filename."))?;
    let (version, sha256) = metadata(&manifest, name, target)?;
    let compressed =
        bounded_file::read_no_follow(archive, COMPRESSED_LIMIT).map_err(io::Error::other)?;
    if digest(&compressed) != sha256 {
        return Err(invalid("Native archive checksum mismatch."));
    }
    let files = decode(&compressed, archive_root(name)?)?;
    Ok(Artifact {
        name: name.into(),
        version,
        target: target.into(),
        sha256,
        files,
    })
}

pub(super) fn select(manifest: &[u8], target: &str) -> io::Result<(String, Version)> {
    if manifest.len() > MANIFEST_LIMIT {
        return Err(invalid("Native manifest exceeds its bound."));
    }
    let manifest: Value = serde_json::from_slice(manifest).map_err(io::Error::other)?;
    let matches = manifest["artifacts"]
        .as_object()
        .ok_or_else(|| invalid("Native manifest artifacts are missing."))?
        .iter()
        .filter(|(_, value)| {
            value["kind"] == "executable-zip"
                && value["target_triples"] == serde_json::json!([target])
        })
        .map(|(name, _)| name)
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err(invalid(
            "Native manifest must select exactly one target archive.",
        ));
    }
    let name = matches[0];
    let (version, _) = metadata(&manifest, name, target)?;
    Ok((name.clone(), version))
}

fn archive_root(name: &str) -> io::Result<&str> {
    name.strip_suffix(".tar.gz")
        .filter(|root| {
            root.as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphanumeric)
                && root
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        })
        .ok_or_else(|| invalid("Invalid native archive filename."))
}

fn metadata(manifest: &Value, name: &str, target: &str) -> io::Result<(Version, String)> {
    archive_root(name)?;
    let metadata = &manifest["artifacts"][name];
    if metadata["kind"] != "executable-zip"
        || metadata["name"] != name
        || metadata["target_triples"] != serde_json::json!([target])
    {
        return Err(invalid("Native archive metadata or target does not match."));
    }
    let sha256 = metadata["checksums"]["sha256"]
        .as_str()
        .filter(|hash| crate::content_digest::is_sha256(hash))
        .ok_or_else(|| invalid("Native archive requires a SHA-256 checksum."))?;
    let mut inventory = metadata["assets"]
        .as_array()
        .ok_or_else(|| invalid("Native archive asset inventory is missing."))?
        .iter()
        .map(|asset| {
            asset["path"]
                .as_str()
                .ok_or_else(|| invalid("Invalid archive asset path."))
        })
        .collect::<io::Result<Vec<_>>>()?;
    inventory.sort_unstable();
    let mut required = FILES;
    required.sort_unstable();
    if inventory != required {
        return Err(invalid("Unexpected native archive asset inventory."));
    }
    let releases = manifest["releases"]
        .as_array()
        .ok_or_else(|| invalid("Native manifest releases are missing."))?
        .iter()
        .filter(|release| {
            release["artifacts"]
                .as_array()
                .is_some_and(|assets| assets.iter().any(|asset| asset == name))
        })
        .collect::<Vec<_>>();
    if releases.len() != 1 || releases[0]["app_name"] != "tmt-cli" {
        return Err(invalid(
            "Native archive must belong to exactly one TMT release.",
        ));
    }
    let version = releases[0]["app_version"]
        .as_str()
        .ok_or_else(|| invalid("Native release version is missing."))?
        .parse()
        .map_err(|_| invalid("Native release version is invalid."))?;
    Ok((version, sha256.into()))
}

fn decode(compressed: &[u8], root: &str) -> io::Result<BTreeMap<String, Vec<u8>>> {
    let mut expanded = Vec::new();
    MultiGzDecoder::new(compressed)
        .take((EXPANDED_LIMIT + 1) as u64)
        .read_to_end(&mut expanded)?;
    if expanded.len() > EXPANDED_LIMIT {
        return Err(invalid("Native archive expansion exceeds its bound."));
    }
    let mut archive = tar::Archive::new(expanded.as_slice());
    let mut files = BTreeMap::new();
    let mut directory_seen = false;
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path_bytes().into_owned();
        let path = std::str::from_utf8(&path)
            .map_err(|_| invalid("Native archive path must be ASCII."))?;
        if path == format!("{root}/") && entry.header().entry_type().is_dir() {
            if entry.header().mode()? & 0o7000 != 0 || entry.size() != 0 {
                return Err(invalid("Native archive directory metadata is invalid."));
            }
            if directory_seen {
                return Err(invalid("Duplicate native archive directory."));
            }
            directory_seen = true;
            continue;
        }
        let name = path
            .strip_prefix(root)
            .and_then(|p| p.strip_prefix('/'))
            .filter(|name| FILES.contains(name))
            .ok_or_else(|| invalid("Unexpected native archive path."))?;
        let mode = entry.header().mode()?;
        if !entry.header().entry_type().is_file()
            || mode & 0o7000 != 0
            || entry.size() == 0
            || (name == "tmt" && mode & 0o111 == 0)
        {
            return Err(invalid(
                "Native archive requires nonempty regular files with safe permissions.",
            ));
        }
        if files.contains_key(name) {
            return Err(invalid("Duplicate native archive file."));
        }
        let mut contents = Vec::new();
        entry.read_to_end(&mut contents)?;
        files.insert(name.into(), contents);
    }
    if files.len() != FILES.len() {
        return Err(invalid("Native archive is missing required files."));
    }
    Ok(files)
}
