//! Strict data-only Office prop-pack validation and immutable references.

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::HashSet, path::Path};
use tmt_core::office_protocol::{OfficeError, OfficeInvocation};

pub const PACK_INPUT_LIMIT: usize = 128 * 1024;
pub const PACK_PROP_LIMIT: usize = 16;
pub const PACK_PIXEL_LIMIT: usize = 65_536;
pub const PROP_PIXEL_LIMIT: usize = 4_096;
pub const PROP_LABEL_LIMIT: usize = crate::indexed_art::LABEL_LIMIT;
/// Version byte + catalog revision + digest, encoded as unpadded base64url.
pub const CATALOG_CURSOR_MAX_BYTES: usize = crate::storage::catalog_cursor::ENCODED_MAX_BYTES;
pub const RASTER_LIMIT: usize = 64;
pub const PALETTE_LIMIT: usize = crate::indexed_art::PALETTE_LIMIT;
pub const FOOTPRINT_LIMIT: u8 = 8;
pub const BUILTIN_DIGEST: &str = tmt_core::office_block::BUILTIN_PROP_PACK_DIGEST;
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

#[derive(Debug)]
pub enum PropPackError {
    Invalid,
    TooLarge,
    Io(std::io::Error),
}

impl PartialEq for PropPackError {
    fn eq(&self, other: &Self) -> bool {
        matches!(
            (self, other),
            (Self::Invalid, Self::Invalid)
                | (Self::TooLarge, Self::TooLarge)
                | (Self::Io(_), Self::Io(_))
        )
    }
}

impl Eq for PropPackError {}

impl std::fmt::Display for PropPackError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Invalid => "Invalid Office prop pack.",
            Self::TooLarge => "Office prop pack exceeds 128 KiB.",
            Self::Io(_) => "Could not read the Office prop pack file.",
        })
    }
}

impl std::error::Error for PropPackError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

pub fn read_pack_file(path: &Path) -> Result<ValidatedPropPack, PropPackError> {
    let bytes =
        crate::bounded_file::read_no_follow(path, PACK_INPUT_LIMIT).map_err(
            |error| match error {
                crate::bounded_file::FileReadError::TooLarge => PropPackError::TooLarge,
                crate::bounded_file::FileReadError::Io(error) => PropPackError::Io(error),
            },
        )?;
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

pub fn command_pack_input(pack: &ValidatedPropPack) -> Value {
    json!({"bytes":STANDARD.encode(pack.bytes())})
}

pub fn framed_digest(bytes: &[u8]) -> String {
    format!(
        "sha256:{}",
        crate::content_digest::framed_sha256(DIGEST_DOMAIN, bytes)
    )
}

pub fn parse_pack_digest(value: &str) -> Option<&str> {
    value
        .strip_prefix("sha256:")
        .filter(|digest| crate::content_digest::is_sha256(digest))
}

pub fn parse_prop_reference(value: &str) -> Option<(&str, &str)> {
    tmt_core::office_art_reference::parse_office_art_reference(value)
}

fn validate_document(pack: &PropPack) -> Result<usize, PropPackError> {
    if pack.format_version != 1
        || !crate::indexed_art::valid_text(&pack.label, PROP_LABEL_LIMIT)
        || !crate::indexed_art::valid_text(&pack.credit, crate::indexed_art::CREDIT_LIMIT)
        || !crate::indexed_art::valid_license(&pack.license)
        || !crate::indexed_art::valid_palette(&pack.palette)
        || !(1..=PACK_PROP_LIMIT).contains(&pack.props.len())
    {
        return Err(PropPackError::Invalid);
    }
    let mut keys = HashSet::with_capacity(pack.props.len());
    let mut total = 0usize;
    for prop in &pack.props {
        if !crate::indexed_art::valid_key(&prop.key)
            || !keys.insert(prop.key.as_str())
            || !crate::indexed_art::valid_text(&prop.label, PROP_LABEL_LIMIT)
            || !(1..=FOOTPRINT_LIMIT).contains(&prop.footprint.width)
            || !(1..=FOOTPRINT_LIMIT).contains(&prop.footprint.height)
            || !(1..=RASTER_LIMIT).contains(&prop.pixels.len())
        {
            return Err(PropPackError::Invalid);
        }
        let count = crate::indexed_art::validate_raster(
            &prop.pixels,
            pack.palette.len(),
            None,
            None,
            RASTER_LIMIT,
            PROP_PIXEL_LIMIT,
        )
        .ok_or(PropPackError::Invalid)?;
        total = total.checked_add(count).ok_or(PropPackError::Invalid)?;
    }
    (total <= PACK_PIXEL_LIMIT)
        .then_some(total)
        .ok_or(PropPackError::Invalid)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PropCommandInput {
    #[serde(default)]
    bytes: Option<String>,
    #[serde(default)]
    digest: Option<String>,
    #[serde(default)]
    expected_revision: Option<u64>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    cursor: Option<String>,
}

pub fn execute(operation: OfficeInvocation, input: &[u8]) -> Vec<u8> {
    serde_json::to_vec(
        &execute_inner(operation, input).unwrap_or_else(|error| json!({"error":error.code()})),
    )
    .unwrap_or_else(|_| br#"{"error":"OFFICE_PROP_CORRUPT"}"#.to_vec())
}

fn execute_inner(operation: OfficeInvocation, input: &[u8]) -> Result<Value, OfficeError> {
    if input.len() > 180_000 {
        return Err(OfficeError::PropInvalid);
    }
    let input: PropCommandInput =
        serde_json::from_slice(input).map_err(|_| OfficeError::PropInvalid)?;
    if operation == OfficeInvocation::LocalPropValidate {
        let candidate = command_pack(&input)?;
        return Ok(pack_projection(&candidate));
    }
    let paths =
        crate::config::ConfigPaths::discover().map_err(|_| OfficeError::CredentialsUnavailable)?;
    let mut storage = crate::storage::Storage::open(paths.database).map_err(storage_prop_error)?;
    let result = match operation {
        OfficeInvocation::LocalPropInstall => {
            let candidate = command_pack(&input)?;
            let revision = input.expected_revision.ok_or(OfficeError::PropInvalid)?;
            storage
                .install_local_prop_pack(revision, &candidate)
                .map(|mutation| mutation_projection(mutation, true))
                .map_err(catalog_error)
        }
        OfficeInvocation::LocalPropRemove => {
            let digest = input.digest.as_deref().ok_or(OfficeError::PropInvalid)?;
            let revision = input.expected_revision.ok_or(OfficeError::PropInvalid)?;
            storage
                .remove_local_prop_pack(revision, digest)
                .map(|mutation| mutation_projection(mutation, false))
                .map_err(catalog_error)
        }
        OfficeInvocation::LocalPropList => storage
            .list_local_prop_packs(input.limit.unwrap_or(20), input.cursor.as_deref())
            .map(list_projection)
            .map_err(catalog_error),
        OfficeInvocation::LocalPropShow => storage
            .show_local_prop_pack(input.digest.as_deref().ok_or(OfficeError::PropInvalid)?)
            .map(snapshot_projection)
            .map_err(catalog_error),
        _ => Err(OfficeError::CredentialsInvalid),
    };
    let close = storage.close().map_err(storage_prop_error);
    match (result, close) {
        (Err(error), _) => Err(error),
        (Ok(value), Ok(())) => Ok(value),
        (Ok(_), Err(error)) => Err(error),
    }
}

fn command_pack(input: &PropCommandInput) -> Result<ValidatedPropPack, OfficeError> {
    let encoded = input.bytes.as_deref().ok_or(OfficeError::PropInvalid)?;
    if encoded.len() > 174_764 {
        return Err(OfficeError::PropInvalid);
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| OfficeError::PropInvalid)?;
    validate_pack(&bytes).map_err(|_| OfficeError::PropInvalid)
}

fn pack_projection(pack: &ValidatedPropPack) -> Value {
    json!({
        "digest":pack.digest(),
        "formatVersion":pack.pack().format_version,
        "label":pack.pack().label,
        "credit":pack.pack().credit,
        "license":pack.pack().license,
        "fileBytes":pack.bytes().len(),
        "pixelCount":pack.pixel_count(),
        "props":pack.pack().props.iter().map(|prop| json!({
            "key":prop.key,
            "label":prop.label,
            "footprint":prop.footprint,
            "raster":{"width":prop.pixels[0].len(),"height":prop.pixels.len()}
        })).collect::<Vec<_>>()
    })
}

fn snapshot_projection(snapshot: crate::storage::LocalPropSnapshot) -> Value {
    let mut value = pack_projection(&snapshot.pack);
    value["builtin"] = json!(snapshot.builtin);
    value["catalogRevision"] = json!(snapshot.catalog_revision);
    value["installedAtMs"] = snapshot
        .installed_at_ms
        .map_or(Value::Null, |value| json!(value));
    value
}

fn mutation_projection(mutation: crate::storage::LocalPropMutation, include_pack: bool) -> Value {
    if include_pack {
        let mut value = snapshot_projection(mutation.snapshot.expect("install returns a snapshot"));
        value["changed"] = json!(mutation.changed);
        value
    } else {
        json!({
            "digest":mutation.digest,
            "catalogRevision":mutation.catalog_revision,
            "changed":mutation.changed
        })
    }
}

fn list_projection(list: crate::storage::LocalPropCatalogList) -> Value {
    json!({
        "catalogRevision":list.catalog_revision,
        "builtins":list.builtins.into_iter().map(snapshot_projection).collect::<Vec<_>>(),
        "packs":list.packs.into_iter().map(snapshot_projection).collect::<Vec<_>>(),
        "excluded":list.excluded.into_iter().map(|excluded| json!({
            "digest":excluded.digest,
            "reason":excluded.reason.code()
        })).collect::<Vec<_>>(),
        "nextCursor":list.next_cursor
    })
}

fn catalog_error(error: crate::storage::LocalPropCatalogError) -> OfficeError {
    use crate::storage::LocalPropCatalogError as Error;
    match error {
        Error::Invalid => OfficeError::PropInvalid,
        Error::Corrupt => OfficeError::PropCorrupt,
        Error::NotFound => OfficeError::PropNotFound,
        Error::Limit => OfficeError::PropLimit,
        Error::Builtin => OfficeError::PropBuiltin,
        Error::RevisionConflict | Error::RevisionExhausted => OfficeError::CatalogRevisionConflict,
        Error::CursorInvalid => OfficeError::CatalogCursorInvalid,
        Error::CursorStale => OfficeError::CatalogCursorStale,
        Error::Storage(error) => storage_prop_error(error),
    }
}

fn storage_prop_error(error: impl std::error::Error) -> OfficeError {
    let _ = error;
    OfficeError::CredentialsUnavailable
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_pack_has_independently_frozen_identity_and_legacy_geometry() {
        let pack = builtin_pack();
        assert_eq!(pack.digest(), BUILTIN_DIGEST);
        assert_eq!(pack.bytes().len(), 1_563);
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
    fn shared_vectors_cover_values_and_full_capacity() {
        let vectors: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../contracts/office/prop-block-vectors.json"
        ))
        .unwrap();
        for case in vectors["packCases"].as_array().unwrap() {
            let bytes = serde_json::to_vec(&case["value"]).unwrap();
            assert_eq!(
                validate_pack(&bytes).is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
        }
        let capacity = &vectors["capacity"];
        let props = (0..capacity["count"].as_u64().unwrap())
            .map(|index| {
                let mut prop = capacity["prop"].clone();
                prop["key"] = serde_json::json!(format!(
                    "{}{:02}",
                    capacity["keyPrefix"].as_str().unwrap(),
                    index
                ));
                prop["label"] = capacity["label"].clone();
                prop["pixels"] = serde_json::json!(vec![
                    capacity["rasterRow"].as_str().unwrap();
                    capacity["rasterRows"].as_u64().unwrap()
                        as usize
                ]);
                prop
            })
            .collect::<Vec<_>>();
        let mut pack = capacity["pack"].clone();
        pack["props"] = serde_json::json!(props);
        let validated = validate_pack(&serde_json::to_vec(&pack).unwrap()).unwrap();
        assert_eq!(validated.pack().props.len(), PACK_PROP_LIMIT);
        assert_eq!(validated.pixel_count(), PACK_PIXEL_LIMIT);
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
            br##"{"formatVersion":1,"formatVersion":1,"label":"x","credit":"y","license":"MIT","palette":["#00000000","#ffffffff"],"props":[{"key":"lamp","label":"Lamp","footprint":{"width":1,"height":1},"pixels":["1"]}]}"##.as_slice(),
            br##"{"formatVersion":1,"label":"x","credit":"y","license":"MIT","palette":["#00000000","#ffffffff"],"props":[{"key":"lamp","label":"Lamp","footprint":{"width":1,"height":1},"pixels":["1"]}],"extra":true}"##,
            br##"{"formatVersion":1,"label":"x","credit":"y","license":"MIT","palette":["#00000000","#ffffffff"],"props":[{"key":"lamp","key":"lamp","label":"Lamp","footprint":{"width":1,"height":1},"pixels":["1"]}]}"##,
            br##"{"formatVersion":1,"label":"x","credit":"y","license":"MIT","palette":["#00000000","#ffffffff"],"props":[{"key":"lamp","label":"Lamp","footprint":{"width":1,"width":1,"height":1},"pixels":["1"]}]}"##,
        ] {
            assert_eq!(validate_pack(bytes), Err(PropPackError::Invalid));
        }
    }

    #[test]
    fn file_acquisition_is_bounded_regular_and_no_follow() {
        let directory = crate::test_support::TestDirectory::new();
        let regular = directory.path.join("pack.json");
        std::fs::write(&regular, BUILTIN_BYTES).unwrap();
        assert_eq!(read_pack_file(&regular).unwrap().digest(), BUILTIN_DIGEST);
        assert!(matches!(
            read_pack_file(&directory.path.join("missing.json")),
            Err(PropPackError::Io(_))
        ));
        let oversized = directory.path.join("oversized.json");
        std::fs::write(&oversized, vec![b' '; PACK_INPUT_LIMIT + 1]).unwrap();
        assert!(matches!(
            read_pack_file(&oversized),
            Err(PropPackError::TooLarge)
        ));
        let link = directory.path.join("link.json");
        std::os::unix::fs::symlink(&regular, &link).unwrap();
        assert!(matches!(read_pack_file(&link), Err(PropPackError::Io(_))));
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
