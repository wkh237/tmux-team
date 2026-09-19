//! A read-only starting composition. Saving and later reading never reseeds it.

use crate::{
    content_digest::framed_sha256,
    office_extension::{bundled_definitions, bundled_instances},
};
use tmt_core::{
    office_extension::ExtensionAttachment,
    office_world::{ObjectKind, Surface, WorldObject},
};

// Domain-framed UUIDv8 keeps preview IDs stable without materializing resources.
pub(crate) fn placement_id(seed: &str, ordinal: u64) -> String {
    let input = serde_json::to_vec(&(seed, ordinal)).expect("finite placement key");
    let hash = framed_sha256(b"tmt-office-placement-v1", &input);
    let mut bytes = *uuid::Uuid::parse_str(&hash[..32])
        .expect("SHA-256 hex prefix")
        .as_bytes();
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(bytes).to_string()
}

/// The former bundled functional entries become ordinary editable world objects.
pub(crate) fn lobby_objects(area_id: &str) -> Vec<WorldObject> {
    bundled_instances()
        .iter()
        .map(|instance| {
            let definition = bundled_definitions()
                .iter()
                .find(|definition| definition.id == instance.definition)
                .expect("bundled instance has a bundled definition");
            let mut placement =
                definition
                    .appearance
                    .placement(instance.x, instance.y, instance.rotation);
            // The left half of the migration Lobby preserves the old commons composition.
            placement.x += 2;
            placement.y += 2;
            WorldObject {
                id: placement_id(&format!("{area_id}:{}", instance.id), 0),
                placement,
                surface: Surface::Floor,
                kind: ObjectKind::Decoration,
                extension: Some(ExtensionAttachment {
                    definition: instance.definition.clone(),
                    binding: instance.binding.clone().into(),
                }),
            }
        })
        .collect()
}
