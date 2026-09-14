//! Strict data-only Office prop-pack validation and immutable references.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, path::Path};

pub const PACK_INPUT_LIMIT: usize = 128 * 1024;
pub const PACK_PROP_LIMIT: usize = 16;
pub const PACK_PIXEL_LIMIT: usize = 65_536;
pub const PROP_PIXEL_LIMIT: usize = 4_096;
pub const RASTER_LIMIT: usize = 64;
pub const PALETTE_LIMIT: usize = 16;
pub const FOOTPRINT_LIMIT: u8 = 8;
pub const BUILTIN_DIGEST: &str =
    "sha256:e1eee20d47773c45ca17058ffad33f3a1ed8ded2c85c88d15706676b894419d8";
pub const BUILTIN_BYTES: &[u8] =
    include_bytes!("../../../../contracts/office/builtin-props-v1.tmtprop.json");

const DIGEST_DOMAIN: &[u8] = b"TMT-OFFICE-PROP-PACK-V1\0";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PropPack {
    pub format_version: u8,
    pub label: String,
    pub credit: String,
    pub license: String,
    pub palette: Vec<String>,
    pub props: Vec<PropDefinition>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PropDefinition {
    pub key: String,
    pub label: String,
    pub footprint: Footprint,
    pub pixels: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Footprint {
    pub width: u8,
    pub height: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedPropPack {
    bytes: Vec<u8>,
    digest: String,
    pack: PropPack,
    pixel_count: usize,
}

impl ValidatedPropPack {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn digest(&self) -> &str {
        &self.digest
    }

    pub fn pack(&self) -> &PropPack {
        &self.pack
    }

    pub fn pixel_count(&self) -> usize {
        self.pixel_count
    }

    pub fn prop(&self, key: &str) -> Option<&PropDefinition> {
        self.pack.props.iter().find(|prop| prop.key == key)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PropPackError {
    Invalid,
    TooLarge,
}

impl std::fmt::Display for PropPackError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Invalid => "Invalid Office prop pack.",
            Self::TooLarge => "Office prop pack exceeds 128 KiB.",
        })
    }
}

impl std::error::Error for PropPackError {}

pub fn read_pack_file(path: &Path) -> Result<ValidatedPropPack, PropPackError> {
    let bytes =
        crate::bounded_file::read(path, PACK_INPUT_LIMIT).map_err(|_| PropPackError::TooLarge)?;
    validate_pack(&bytes)
}

pub fn validate_pack(bytes: &[u8]) -> Result<ValidatedPropPack, PropPackError> {
    if bytes.len() > PACK_INPUT_LIMIT {
        return Err(PropPackError::TooLarge);
    }
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) || std::str::from_utf8(bytes).is_err() {
        return Err(PropPackError::Invalid);
    }
    let pack: PropPack = serde_json::from_slice(bytes).map_err(|_| PropPackError::Invalid)?;
    let pixel_count = validate_document(&pack)?;
    Ok(ValidatedPropPack {
        bytes: bytes.to_vec(),
        digest: framed_digest(bytes),
        pack,
        pixel_count,
    })
}

pub fn builtin_pack() -> ValidatedPropPack {
    let pack = validate_pack(BUILTIN_BYTES).expect("embedded prop pack is a reviewed fixture");
    assert_eq!(pack.digest(), BUILTIN_DIGEST);
    pack
}

pub fn framed_digest(bytes: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(DIGEST_DOMAIN);
    digest.update((bytes.len() as u64).to_be_bytes());
    digest.update(bytes);
    let digest = digest.finalize();
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("sha256:{hex}")
}

pub fn parse_pack_digest(value: &str) -> Option<&str> {
    value.strip_prefix("sha256:").filter(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

pub fn parse_prop_reference(value: &str) -> Option<(&str, &str)> {
    let (digest, key) = value.split_once('/')?;
    parse_pack_digest(digest)?;
    valid_key(key).then_some((digest, key))
}

fn validate_document(pack: &PropPack) -> Result<usize, PropPackError> {
    if pack.format_version != 1
        || !valid_text(&pack.label, 80)
        || !valid_text(&pack.credit, 120)
        || pack.license.is_empty()
        || pack.license.len() > 64
        || !pack
            .license
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".+-".contains(&byte))
        || !(1..=PALETTE_LIMIT).contains(&pack.palette.len())
        || pack.palette.first().map(String::as_str) != Some("#00000000")
        || !(1..=PACK_PROP_LIMIT).contains(&pack.props.len())
    {
        return Err(PropPackError::Invalid);
    }
    for color in pack.palette.iter().skip(1) {
        if !valid_opaque_color(color) {
            return Err(PropPackError::Invalid);
        }
    }
    let mut keys = HashSet::with_capacity(pack.props.len());
    let mut total = 0usize;
    for prop in &pack.props {
        if !valid_key(&prop.key)
            || !keys.insert(prop.key.as_str())
            || !valid_text(&prop.label, 80)
            || !(1..=FOOTPRINT_LIMIT).contains(&prop.footprint.width)
            || !(1..=FOOTPRINT_LIMIT).contains(&prop.footprint.height)
            || !(1..=RASTER_LIMIT).contains(&prop.pixels.len())
        {
            return Err(PropPackError::Invalid);
        }
        let width = prop.pixels.first().map(String::len).unwrap_or_default();
        if !(1..=RASTER_LIMIT).contains(&width) {
            return Err(PropPackError::Invalid);
        }
        let count = width
            .checked_mul(prop.pixels.len())
            .filter(|count| *count <= PROP_PIXEL_LIMIT)
            .ok_or(PropPackError::Invalid)?;
        for row in &prop.pixels {
            if row.len() != width
                || !row.bytes().all(|byte| {
                    let index = match byte {
                        b'0'..=b'9' => byte - b'0',
                        b'a'..=b'f' => byte - b'a' + 10,
                        _ => return false,
                    };
                    usize::from(index) < pack.palette.len()
                })
            {
                return Err(PropPackError::Invalid);
            }
        }
        total = total.checked_add(count).ok_or(PropPackError::Invalid)?;
    }
    (total <= PACK_PIXEL_LIMIT)
        .then_some(total)
        .ok_or(PropPackError::Invalid)
}

fn valid_text(value: &str, max_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= max_bytes && !value.chars().any(char::is_control)
}

fn valid_key(value: &str) -> bool {
    (1..=32).contains(&value.len())
        && value.bytes().enumerate().all(|(index, byte)| match byte {
            b'a'..=b'z' => true,
            b'0'..=b'9' | b'-' => index > 0,
            _ => false,
        })
}

fn valid_opaque_color(value: &str) -> bool {
    value.len() == 9
        && value.starts_with('#')
        && value[1..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && value.ends_with("ff")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_pack_has_independently_frozen_identity_and_legacy_geometry() {
        let pack = builtin_pack();
        assert_eq!(pack.digest(), BUILTIN_DIGEST);
        assert_eq!(pack.bytes().len(), 988);
        assert_eq!(
            pack.pack()
                .props
                .iter()
                .map(|prop| (
                    prop.key.as_str(),
                    prop.footprint.width,
                    prop.footprint.height
                ))
                .collect::<Vec<_>>(),
            [
                ("desk", 4, 2),
                ("chair", 2, 2),
                ("plant", 2, 2),
                ("rug", 6, 4)
            ]
        );
    }

    #[test]
    fn exact_bytes_and_framing_change_identity() {
        let original = validate_pack(BUILTIN_BYTES).unwrap();
        let mut changed = BUILTIN_BYTES.to_vec();
        changed.push(b' ');
        let changed = validate_pack(&changed).unwrap();
        assert_ne!(original.digest(), changed.digest());
        assert_ne!(
            original.digest().strip_prefix("sha256:").unwrap(),
            crate::content_digest::sha256(BUILTIN_BYTES)
        );
    }

    #[test]
    fn typed_decode_rejects_duplicate_and_unknown_fields() {
        for bytes in [
            br##"{"formatVersion":1,"formatVersion":1,"label":"x","credit":"y","license":"MIT","palette":["#00000000"],"props":[]}"##.as_slice(),
            br##"{"formatVersion":1,"label":"x","credit":"y","license":"MIT","palette":["#00000000"],"props":[],"extra":true}"##,
        ] {
            assert_eq!(validate_pack(bytes), Err(PropPackError::Invalid));
        }
    }

    #[test]
    fn invalid_palette_pixels_keys_and_bounds_fail_closed() {
        let valid = br##"{"formatVersion":1,"label":"x","credit":"y","license":"MIT","palette":["#00000000","#ffffffff"],"props":[{"key":"lamp","label":"Lamp","footprint":{"width":1,"height":1},"pixels":["1"]}]}"##;
        assert!(validate_pack(valid).is_ok());
        for (from, to) in [
            ("#ffffffff", "#fffffffe"),
            ("\"1\"]", "\"2\"]"),
            ("\"lamp\"", "\"Lamp\""),
            ("\"width\":1", "\"width\":0"),
        ] {
            let changed = String::from_utf8(valid.to_vec()).unwrap().replace(from, to);
            assert_eq!(
                validate_pack(changed.as_bytes()),
                Err(PropPackError::Invalid)
            );
        }
        assert_eq!(
            validate_pack(&vec![b' '; PACK_INPUT_LIMIT + 1]),
            Err(PropPackError::TooLarge)
        );
    }

    #[test]
    fn references_are_exact() {
        let reference = format!("{BUILTIN_DIGEST}/desk");
        assert_eq!(
            parse_prop_reference(&reference),
            Some((BUILTIN_DIGEST, "desk"))
        );
        assert!(parse_prop_reference(&reference.to_uppercase()).is_none());
        assert!(parse_prop_reference(&format!("{BUILTIN_DIGEST}/Desk")).is_none());
    }
}
