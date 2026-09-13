//! Readable block input/output. Firestore envelopes belong to the remote adapter.

use serde::Deserialize;
use serde_json::{Value, json};
use std::path::Path;
use tmt_core::{
    office_block::{
        BLOCK_SIZE, BlockLayout, Furniture, FurnitureAsset, INPUT_LIMIT, MAX_REVISION, OBJECT_LIMIT,
    },
    office_protocol::OfficeError,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LayoutInput {
    objects: Vec<ObjectInput>,
}

impl LayoutInput {
    pub(crate) fn validate(self) -> Result<BlockLayout, OfficeError> {
        validated_objects(self.objects)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ObjectInput {
    asset: String,
    x: u8,
    y: u8,
    rotation: u8,
}

fn validated_objects(objects: Vec<ObjectInput>) -> Result<BlockLayout, OfficeError> {
    let objects = objects
        .into_iter()
        .map(|object| {
            Ok(Furniture {
                asset: FurnitureAsset::parse(&object.asset).ok_or(OfficeError::LayoutInvalid)?,
                x: object.x,
                y: object.y,
                rotation: object.rotation,
            })
        })
        .collect::<Result<Vec<_>, OfficeError>>()?;
    BlockLayout::new(objects).map_err(|_| OfficeError::LayoutInvalid)
}

pub fn read_layout_file(path: &Path) -> Result<BlockLayout, OfficeError> {
    let bytes =
        crate::bounded_file::read(path, INPUT_LIMIT).map_err(|_| OfficeError::LayoutInvalid)?;
    decode_layout(&bytes)
}

pub(crate) fn decode_layout(bytes: &[u8]) -> Result<BlockLayout, OfficeError> {
    if bytes.len() > INPUT_LIMIT {
        return Err(OfficeError::LayoutInvalid);
    }
    let input: LayoutInput =
        serde_json::from_slice(bytes).map_err(|_| OfficeError::LayoutInvalid)?;
    input.validate()
}

pub(crate) fn layout_value(layout: &BlockLayout) -> Value {
    json!({"objects": layout.objects().iter().map(|object| json!({
        "asset": object.asset.name(), "x":object.x, "y":object.y,"rotation":object.rotation
    })).collect::<Vec<_>>()})
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockSnapshot {
    pub block_id: String,
    pub revision: u64,
    pub layout: BlockLayout,
}

impl BlockSnapshot {
    pub fn public_value(&self) -> Value {
        let mut value = self.wire_value();
        value["limits"] = json!({"size":BLOCK_SIZE,"objects":OBJECT_LIMIT});
        value["catalog"] = json!(
            FurnitureAsset::ALL
                .iter()
                .map(|asset| {
                    let (width, height) = asset.dimensions();
                    json!({"asset":asset.name(),"width":width,"height":height})
                })
                .collect::<Vec<_>>()
        );
        value
    }

    pub(crate) fn wire_value(&self) -> Value {
        let mut value = layout_value(&self.layout);
        value["blockId"] = json!(self.block_id);
        value["revision"] = json!(self.revision);
        value
    }

    pub(crate) fn decode(bytes: &[u8]) -> Result<Self, OfficeError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Snapshot {
            block_id: String,
            revision: u64,
            objects: Vec<ObjectInput>,
        }
        let wire: Snapshot =
            serde_json::from_slice(bytes).map_err(|_| OfficeError::CredentialsInvalid)?;
        if uuid::Uuid::parse_str(&wire.block_id)
            .ok()
            .is_none_or(|id| id.to_string() != wire.block_id)
            || wire.revision > MAX_REVISION
        {
            return Err(OfficeError::CredentialsInvalid);
        }
        let layout =
            validated_objects(wire.objects).map_err(|_| OfficeError::CredentialsInvalid)?;
        if wire.revision == 0 && !layout.objects().is_empty() {
            return Err(OfficeError::CredentialsInvalid);
        }
        Ok(Self {
            block_id: wire.block_id,
            revision: wire.revision,
            layout,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readable_wire_round_trips_without_exposing_storage_tokens() {
        let layout =
            decode_layout(br#"{"objects":[{"asset":"desk","x":30,"y":28,"rotation":1}]}"#).unwrap();
        assert_eq!(layout.encode(), ["d1us"]);
        let snapshot = BlockSnapshot {
            block_id: "11111111-1111-4111-8111-111111111111".into(),
            revision: 1,
            layout,
        };
        let bytes = serde_json::to_vec(&snapshot.wire_value()).unwrap();
        assert_eq!(BlockSnapshot::decode(&bytes).unwrap(), snapshot);
        assert_eq!(snapshot.public_value()["objects"][0]["asset"], "desk");
        assert_eq!(
            snapshot.public_value()["catalog"].as_array().unwrap().len(),
            4
        );
    }

    #[test]
    fn actual_readable_inputs_conform_to_shared_literal_vectors() {
        let vectors: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../contracts/office/block-v1.vectors.json"
        ))
        .unwrap();
        for vector in vectors {
            let result =
                decode_layout(&serde_json::to_vec(&json!({"objects":[vector["item"]]})).unwrap());
            assert_eq!(
                result.is_ok(),
                vector["valid"].as_bool().unwrap(),
                "{}",
                vector["name"]
            );
        }
    }

    #[test]
    fn malformed_envelopes_and_oversized_files_are_rejected() {
        for bytes in [
            b"{}".as_slice(),
            br#"{"objects":[],"extra":true}"#,
            br#"{"objects":["d000"]}"#,
            br#"{"objects":[],"objects":[]}"#,
        ] {
            assert_eq!(decode_layout(bytes), Err(OfficeError::LayoutInvalid));
        }
        assert_eq!(
            decode_layout(&vec![b' '; INPUT_LIMIT + 1]),
            Err(OfficeError::LayoutInvalid)
        );
        let directory = crate::test_support::TestDirectory::new();
        let file = directory.path.join("layout.json");
        std::fs::write(&file, br#"{"objects":[]}"#).unwrap();
        assert!(read_layout_file(&file).unwrap().objects().is_empty());
        std::fs::write(&file, vec![b' '; INPUT_LIMIT + 1]).unwrap();
        assert_eq!(read_layout_file(&file), Err(OfficeError::LayoutInvalid));
        assert_eq!(
            read_layout_file(&directory.path),
            Err(OfficeError::LayoutInvalid)
        );
    }
}
