//! Stable lowercase SHA-256 encoding for file-integrity evidence.

use sha2::{Digest, Sha256};

pub(crate) fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
