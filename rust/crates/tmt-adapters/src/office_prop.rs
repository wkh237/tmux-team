//! Strict data-only Office prop-pack validation and immutable references.

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::HashSet, path::Path, sync::OnceLock};
use tmt_core::office_protocol::{OfficeError, OfficeInvocation};

mod customization;
mod quality;
pub use customization::{PropCapabilities, TextCapability, TextRegion, TintCapability};
pub use quality::{QualityWarning, quality_warnings};

pub const V1_PACK_INPUT_LIMIT: usize = 128 * 1024;
pub const PACK_INPUT_LIMIT: usize = 512 * 1024;
pub const ENCODED_INPUT_LIMIT: usize = PACK_INPUT_LIMIT.div_ceil(3) * 4;
pub const PROTOCOL_INPUT_LIMIT: usize = ENCODED_INPUT_LIMIT + 1024;
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
pub const WORKSHOP_DIGEST: &str =
    "sha256:288fb4f9ef08db8bdf635fbd1b16a3d602fbe0d53a095d96a7988969dabe3529";
pub const WORKSHOP_BYTES: &[u8] =
    include_bytes!("../../../../contracts/office/workshop-furniture-v2.tmtprop.json");
pub const COMMONS_DIGEST: &str =
    "sha256:39a02590febbe0b7e9175951db1d7908a9b66ef32aa37eeb1ed9aa5cd524f63c";
pub const COMMONS_BYTES: &[u8] =
    include_bytes!("../../../../contracts/office/commons-props-v2.tmtprop.json");
pub const WHITEBOARD_DIGEST: &str =
    "sha256:2514687c911f644e28ea816e2c28b611d2c074e0105e584e6bba86ca208797e8";
pub const WHITEBOARD_BYTES: &[u8] =
    include_bytes!("../../../../contracts/office/whiteboard-props-v2.tmtprop.json");
pub const BROADCASTER_DIGEST: &str =
    "sha256:00f2f262077a0486fb3f4524a4efb6125c64a4349faaada079b13f6b25067a04";
pub const BROADCASTER_BYTES: &[u8] =
    include_bytes!("../../../../contracts/office/broadcaster-props-v2.tmtprop.json");
pub const STUDY_DIGEST: &str =
    "sha256:78f0c0dc0700aaa37c55ae8cbe91c2d96585555a06e093a9131b529791360eed";
pub const STUDY_BYTES: &[u8] =
    include_bytes!("../../../../contracts/office/study-furniture-v2.tmtprop.json");
pub const WALL_DIGEST: &str =
    "sha256:5303fe9a3e5bf8a22c9958faeef1922a3cc21cfefb95a7b701a6a86213ac4415";
pub const WALL_BYTES: &[u8] =
    include_bytes!("../../../../contracts/office/wall-props-v2.tmtprop.json");
pub const MODULAR_WORKSTATION_DIGEST: &str =
    "sha256:10dc14a38d1cb0c92148c084b5e6239a54ee401348070444ae65fe8f6d815755";
pub const MODULAR_WORKSTATION_BYTES: &[u8] =
    include_bytes!("../../../../contracts/office/modular-workstation-v2.tmtprop.json");
pub const MODULAR_MOUNTED_DIGEST: &str =
    "sha256:86e7784ccb08d6c8804de7deeb2e3063898d3804e6ed81e3f7c8735b1996c7eb";
pub const MODULAR_MOUNTED_BYTES: &[u8] =
    include_bytes!("../../../../contracts/office/modular-mounted-v2.tmtprop.json");
pub const MODULAR_LOUNGE_DIGEST: &str =
    "sha256:a4538f15b7da963679094f89d6f954215453492b5eb23bde40a4ffc6969a64b2";
pub const MODULAR_LOUNGE_BYTES: &[u8] =
    include_bytes!("../../../../contracts/office/modular-lounge-v2.tmtprop.json");
pub const MODULAR_FACILITIES_DIGEST: &str =
    "sha256:b400ccadbacad373c9f420845a820256840829de7856f587cd5fd7d78786a55c";
pub const MODULAR_FACILITIES_BYTES: &[u8] =
    include_bytes!("../../../../contracts/office/modular-facilities-v2.tmtprop.json");
pub const MODULAR_RECEPTION_DIGEST: &str =
    "sha256:a00df6330d569dd6ab8d94bab391c074306be6529fdd224d5da9f9ef601052dc";
pub const MODULAR_RECEPTION_BYTES: &[u8] =
    include_bytes!("../../../../contracts/office/modular-reception-v2.tmtprop.json");

const DIGEST_DOMAIN: &[u8] = b"TMT-OFFICE-PROP-PACK-V1\0";
const DIRECTIONAL_DIGEST_DOMAIN: &[u8] = b"TMT-OFFICE-PROP-PACK-V2\0";

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
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub pixels: Option<Vec<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub frames: Option<[Vec<String>; 4]>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub customization: Option<PropCapabilities>,
}

// An omitted version-specific field is allowed; an explicit null is not.
fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

impl PropDefinition {
    pub fn permits_customization(
        &self,
        value: Option<&tmt_core::office_block::PropCustomization>,
    ) -> bool {
        let Some(value) = value else {
            return true;
        };
        self.customization.as_ref().is_some_and(|capabilities| {
            (value.tint.is_none() || capabilities.tint.is_some())
                && (value.text.is_none() || capabilities.text.is_some())
        })
    }

    fn rasters(&self) -> &[Vec<String>] {
        match (&self.pixels, &self.frames) {
            (Some(pixels), None) => std::slice::from_ref(pixels),
            (None, Some(frames)) => frames.as_slice(),
            _ => &[],
        }
    }
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
            Self::TooLarge => "Office prop pack exceeds its format's byte limit.",
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
    if pack.format_version == 1 && bytes.len() > V1_PACK_INPUT_LIMIT {
        return Err(PropPackError::TooLarge);
    }
    let pixel_count = validate_document(&pack)?;
    Ok(ValidatedPropPack {
        bytes: bytes.to_vec(),
        digest: framed_digest(bytes, pack.format_version),
        pack,
        pixel_count,
    })
}

pub fn builtin_pack() -> ValidatedPropPack {
    builtin_packs()[0].clone()
}

/// Immutable built-ins are admitted once per invocation, never installed as catalog rows.
pub fn builtin_packs() -> &'static [ValidatedPropPack] {
    static PACKS: OnceLock<Vec<ValidatedPropPack>> = OnceLock::new();
    PACKS.get_or_init(|| {
        [
            (BUILTIN_DIGEST, BUILTIN_BYTES),
            (WORKSHOP_DIGEST, WORKSHOP_BYTES),
            (COMMONS_DIGEST, COMMONS_BYTES),
            (WHITEBOARD_DIGEST, WHITEBOARD_BYTES),
            (BROADCASTER_DIGEST, BROADCASTER_BYTES),
            (STUDY_DIGEST, STUDY_BYTES),
            (WALL_DIGEST, WALL_BYTES),
            (MODULAR_WORKSTATION_DIGEST, MODULAR_WORKSTATION_BYTES),
            (MODULAR_MOUNTED_DIGEST, MODULAR_MOUNTED_BYTES),
            (MODULAR_LOUNGE_DIGEST, MODULAR_LOUNGE_BYTES),
            (MODULAR_FACILITIES_DIGEST, MODULAR_FACILITIES_BYTES),
            (MODULAR_RECEPTION_DIGEST, MODULAR_RECEPTION_BYTES),
        ]
        .into_iter()
        .map(|(digest, bytes)| {
            let pack = validate_pack(bytes).expect("embedded prop pack is a reviewed fixture");
            assert_eq!(pack.digest(), digest);
            pack
        })
        .collect()
    })
}

pub fn builtin_by_digest(digest: &str) -> Option<&'static ValidatedPropPack> {
    builtin_packs().iter().find(|pack| pack.digest() == digest)
}

pub fn command_pack_input(pack: &ValidatedPropPack) -> Value {
    json!({"bytes":STANDARD.encode(pack.bytes())})
}

fn framed_digest(bytes: &[u8], version: u8) -> String {
    format!(
        "sha256:{}",
        crate::content_digest::framed_sha256(
            if version == 2 {
                DIRECTIONAL_DIGEST_DOMAIN
            } else {
                DIGEST_DOMAIN
            },
            bytes
        )
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
    let directional = pack.format_version == 2;
    let footprint_limit = if directional {
        tmt_core::office_block::PROP_FOOTPRINT_LIMIT
    } else {
        FOOTPRINT_LIMIT
    };
    if !matches!(pack.format_version, 1 | 2)
        || !crate::indexed_art::valid_text(&pack.label, PROP_LABEL_LIMIT)
        || !crate::indexed_art::valid_text(&pack.credit, crate::indexed_art::CREDIT_LIMIT)
        || !crate::indexed_art::valid_license(&pack.license)
        || !crate::indexed_art::valid_palette_with_limit(
            &pack.palette,
            if directional { 256 } else { PALETTE_LIMIT },
        )
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
            || !(1..=footprint_limit).contains(&prop.footprint.width)
            || !(1..=footprint_limit).contains(&prop.footprint.height)
            || (directional && (prop.frames.is_none() || prop.pixels.is_some()))
            || (!directional && (prop.pixels.is_none() || prop.frames.is_some()))
            || (!directional && prop.customization.is_some())
        {
            return Err(PropPackError::Invalid);
        }
        for pixels in prop.rasters() {
            let count = crate::indexed_art::validate_encoded_raster(
                pixels,
                pack.palette.len(),
                None,
                None,
                if directional { 128 } else { RASTER_LIMIT },
                if directional {
                    16_384
                } else {
                    PROP_PIXEL_LIMIT
                },
                if directional { 2 } else { 1 },
            )
            .ok_or(PropPackError::Invalid)?;
            if directional
                && !pixels
                    .iter()
                    .any(|row| row.bytes().any(|byte| byte != b'0'))
            {
                return Err(PropPackError::Invalid);
            }
            total = total.checked_add(count).ok_or(PropPackError::Invalid)?;
        }
        if !customization::valid(prop, pack.palette.len()) {
            return Err(PropPackError::Invalid);
        }
    }
    (total
        <= if directional {
            131_072
        } else {
            PACK_PIXEL_LIMIT
        })
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
    if input.len() > PROTOCOL_INPUT_LIMIT {
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
    if encoded.len() > ENCODED_INPUT_LIMIT {
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
        "props":pack.pack().props.iter().map(|prop| {
            let mut value = json!({"key":prop.key,"label":prop.label,"footprint":prop.footprint});
            let dimensions = prop.rasters().iter().map(|pixels| json!({
                "width": pixels[0].len() / if pack.pack().format_version == 2 { 2 } else { 1 },
                "height": pixels.len()
            })).collect::<Vec<_>>();
            if pack.pack().format_version == 2 { value["frames"] = json!(dimensions); }
            else { value["raster"] = dimensions[0].clone(); }
            if let Some(customization) = &prop.customization {
                let fields = [("tint", customization.tint.is_some()), ("text", customization.text.is_some())]
                    .into_iter().filter_map(|(name, present)| present.then_some(name)).collect::<Vec<_>>();
                value["customizable"] = json!(fields);
            }
            value
        }).collect::<Vec<_>>()
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

/// Stable catalog errors shared by CLI/companion and local browser adapters.
pub fn catalog_error(error: crate::storage::LocalPropCatalogError) -> OfficeError {
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

    const DIRECTIONAL_SAMPLE: &[u8] =
        include_bytes!("../../../../contracts/office/prop-pack-v2-sample.tmtprop.json");

    #[test]
    fn directional_frames_have_independent_identity_and_summary_dimensions() {
        let pack = validate_pack(DIRECTIONAL_SAMPLE).unwrap();
        assert_eq!(
            pack.digest(),
            "sha256:9a8dfa388f0c13ce32feeb9ee959e25e3eec624ecde16f04697fa7d4264c4078"
        );
        assert_eq!(pack.pixel_count(), 32);
        let summary = pack_projection(&pack);
        assert_eq!(
            summary["props"][0]["frames"],
            json!([
                {"width":4,"height":2}, {"width":2,"height":4},
                {"width":4,"height":2}, {"width":2,"height":4}
            ])
        );
        assert!(summary["props"][0].get("raster").is_none());
        assert!(
            !String::from_utf8(serde_json::to_vec(&summary).unwrap())
                .unwrap()
                .contains("00100101")
        );
    }

    #[test]
    fn directional_admission_rejects_invalid_and_mixed_frame_encodings() {
        for kind in [
            "missing",
            "extra",
            "mixed",
            "null",
            "empty",
            "odd",
            "index",
            "uppercase",
        ] {
            let mut value: Value = serde_json::from_slice(DIRECTIONAL_SAMPLE).unwrap();
            let prop = &mut value["props"][0];
            match kind {
                "missing" => {
                    prop["frames"].as_array_mut().unwrap().pop();
                }
                "extra" => {
                    prop["frames"].as_array_mut().unwrap().push(json!(["01"]));
                }
                "mixed" => prop["pixels"] = json!(["01"]),
                "null" => prop["pixels"] = Value::Null,
                "empty" => prop["frames"][0] = json!(["0000"]),
                "odd" => prop["frames"][0] = json!(["001"]),
                "index" => prop["frames"][0] = json!(["ff"]),
                "uppercase" => prop["frames"][0] = json!(["0A"]),
                _ => unreachable!(),
            }
            assert!(
                validate_pack(&serde_json::to_vec(&value).unwrap()).is_err(),
                "{kind}"
            );
        }
    }

    #[test]
    fn version_specific_bytes_and_base64_envelope_are_bounded() {
        let mut bytes = DIRECTIONAL_SAMPLE.to_vec();
        bytes.resize(PACK_INPUT_LIMIT, b' ');
        let pack = validate_pack(&bytes).unwrap();
        let input = command_pack_input(&pack);
        assert_eq!(input["bytes"].as_str().unwrap().len(), ENCODED_INPUT_LIMIT);
        let envelope = serde_json::to_vec(&input).unwrap();
        assert!(envelope.len() < PROTOCOL_INPUT_LIMIT);
        assert!(execute_inner(OfficeInvocation::LocalPropValidate, &envelope).is_ok());
        bytes.push(b' ');
        assert_eq!(validate_pack(&bytes), Err(PropPackError::TooLarge));
        let mut legacy = BUILTIN_BYTES.to_vec();
        legacy.resize(V1_PACK_INPUT_LIMIT + 1, b' ');
        assert_eq!(validate_pack(&legacy), Err(PropPackError::TooLarge));
    }

    #[test]
    fn directional_total_cell_budget_accepts_the_boundary_and_rejects_one_extra_row() {
        let mut value: Value = serde_json::from_slice(DIRECTIONAL_SAMPLE).unwrap();
        let sample = value["props"][0].clone();
        value["props"] = Value::Array(
            (0..16)
                .map(|index| {
                    let mut prop = sample.clone();
                    prop["key"] = json!(format!("capacity-{index}"));
                    prop["frames"] = json!(vec![vec!["01".repeat(128); 16]; 4]);
                    prop
                })
                .collect(),
        );
        assert!(validate_pack(&serde_json::to_vec(&value).unwrap()).is_ok());
        // All individual rasters remain within their side/cell limits; only
        // the 131,072-cell aggregate budget is crossed by this extra row.
        value["props"][0]["frames"][0]
            .as_array_mut()
            .unwrap()
            .push(json!("01".repeat(128)));
        assert_eq!(
            validate_pack(&serde_json::to_vec(&value).unwrap()),
            Err(PropPackError::Invalid)
        );
    }

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
