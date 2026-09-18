//! Furnished new-world composition; retained layouts never pass through this preset.

use super::{lobby_objects, placement_id};
use crate::office_prop::{
    MODULAR_FACILITIES_DIGEST, MODULAR_LOUNGE_DIGEST, MODULAR_MOUNTED_DIGEST,
    MODULAR_RECEPTION_DIGEST, MODULAR_WORKSTATION_DIGEST, STUDY_DIGEST, WALL_DIGEST,
    WORKSHOP_DIGEST, builtin_packs,
};
use tmt_core::{
    office_block::{PropCustomization, PropPlacement},
    office_map::{
        Area, AreaKind, Axis, OfficeMap,
        modules::{Material, Module, ModuleDraft, ModuleLayout, Slot},
    },
    office_world::{ObjectKind, Surface, WallFace, WorldLayout, WorldObject},
};

/// The catalog, not the composition, owns artwork dimensions and identity.
fn appearance(digest: &str, key: &str, x: i32, y: i32) -> PropPlacement {
    let definition = builtin_packs()
        .iter()
        .find(|pack| pack.digest() == digest)
        .and_then(|pack| pack.prop(key))
        .expect("starter art is an admitted bundled prop");
    PropPlacement {
        prop: format!("{digest}/{key}"),
        footprint_width: definition.footprint.width,
        footprint_height: definition.footprint.height,
        x,
        y,
        rotation: 0,
        customization: None,
    }
}

fn prop(seed: &str, ordinal: usize, digest: &str, key: &str, x: i32, y: i32) -> WorldObject {
    WorldObject {
        id: placement_id(seed, ordinal as u64),
        placement: appearance(digest, key, x, y),
        kind: ObjectKind::Decoration,
        surface: Surface::Floor,
        extension: None,
    }
}

fn mount(object: &mut WorldObject, kind: ObjectKind, elevation: u8) {
    object.kind = kind;
    object.surface = Surface::Wall {
        axis: Axis::Horizontal,
        face: WallFace::Positive,
        elevation,
    };
}

pub(crate) fn new_world(seed: &str) -> WorldLayout {
    let lobby_id = placement_id(seed, u64::MAX);
    let mut modules = vec![Module {
        area: Area {
            id: lobby_id.clone(),
            name: "Lobby".into(),
            kind: AreaKind::Lobby,
        },
        slot: Slot::Lobby,
        material: Material::Workshop,
    }];
    for (index, (column, row)) in [(0, -1), (1, -1), (0, 2), (1, 2)].into_iter().enumerate() {
        modules.push(Module {
            area: Area {
                id: placement_id(&format!("{seed}:office"), index as u64),
                name: format!("Office {:02}", index + 1),
                kind: AreaKind::Personal { identity_id: None },
            },
            slot: Slot::Office { column, row },
            material: Material::Workshop,
        });
    }
    let map = OfficeMap::from_modules(ModuleDraft {
        primary_lobby_id: lobby_id.clone(),
        modules,
        layout: ModuleLayout::CompactGrid,
    })
    .expect("starter modules have connected cardinal circulation");

    // Reuse canonical host bindings. Reading the preset creates no documents,
    // identities, room memberships or message resources.
    let mut objects = lobby_objects(&lobby_id);
    for object in &mut objects {
        let (key, x, y) = match object
            .extension
            .as_ref()
            .expect("bundled binding")
            .definition
            .as_str()
        {
            "tmt-discussion-board" => ("lobby-discussion-board", 64, 18),
            "tmt-whiteboard" => ("lobby-whiteboard", 82, 18),
            "tmt-broadcaster" => ("lobby-radio", 76, 51),
            _ => unreachable!("starter uses the three canonical Lobby facilities"),
        };
        object.placement = appearance(MODULAR_FACILITIES_DIGEST, key, x, y);
    }

    // Four furnished pockets flank the open x=48..56 / y=40..48 cross-axis.
    // Rugs precede furniture so the stored painter order remains intentional.
    for (key, x, y) in [
        ("woven-rug", 17, 27),
        ("woven-rug", 26, 58),
        ("woven-rug", 72, 62),
    ] {
        objects.push(prop(seed, objects.len(), WORKSHOP_DIGEST, key, x, y));
    }
    // A broad welcoming lounge and a smaller reading nook, not four repeated
    // desks. These are ordinary movable props, not a flattened background.
    for (key, x, y) in [
        ("lounge-sofa", 8, 8),
        ("lounge-sofa", 24, 8),
        ("lounge-plant", 3, 6),
        ("lounge-plant", 93, 6),
        ("lounge-plant", 93, 58),
        ("lounge-plant", 39, 6),
        ("lounge-plant", 58, 6),
    ] {
        objects.push(prop(seed, objects.len(), MODULAR_LOUNGE_DIGEST, key, x, y));
    }
    for (key, x, y) in [
        ("reception-table", 16, 24),
        ("reception-armchair", 4, 26),
        ("reception-armchair", 34, 26),
        ("reception-armchair", 28, 50),
        ("reception-table", 72, 54),
        ("reception-armchair", 58, 58),
    ] {
        objects.push(prop(
            seed,
            objects.len(),
            MODULAR_RECEPTION_DIGEST,
            key,
            x,
            y,
        ));
    }
    for (key, x, y) in [
        ("oak-bookcase", 4, 50),
        ("reading-lamp", 18, 52),
        ("oak-bookcase", 88, 52),
    ] {
        objects.push(prop(seed, objects.len(), STUDY_DIGEST, key, x, y));
    }
    for (key, x, elevation) in [
        ("mounted-shelf", 4, 3),
        ("mounted-shelf", 84, 3),
        ("mounted-sconce", 18, 5),
        ("mounted-sconce", 72, 5),
    ] {
        let mut object = prop(seed, objects.len(), MODULAR_MOUNTED_DIGEST, key, x, 0);
        mount(
            &mut object,
            if key == "mounted-sconce" {
                ObjectKind::WallLight
            } else {
                ObjectKind::Decoration
            },
            elevation,
        );
        objects.push(object);
    }
    let mut sign = prop(seed, objects.len(), WALL_DIGEST, "crew-sign", 32, 0);
    sign.placement.customization = Some(PropCustomization {
        tint: None,
        text: Some("TMT OFFICE".into()),
    });
    mount(&mut sign, ObjectKind::Decoration, 7);
    objects.push(sign);

    // Identical furniture does not create identities or assign residents.
    let source = map.modules().expect("starter uses modules");
    for module in source
        .modules
        .iter()
        .filter(|module| matches!(module.slot, Slot::Office { .. }))
    {
        let bounds = module
            .bounds(source.layout)
            .expect("admitted office bounds");
        let (x, y) = (bounds.x, bounds.y);
        // Place the workstation behind the full-height foreground wall. The
        // chair sits behind the desk; the terminal remains independent art.
        // Keep x=20..28 clear for the southern rooms' rear entrance.
        for (key, dx, dy) in [
            ("workstation-chair", 8, 0),
            ("workstation-desk", 4, 0),
            ("workstation-terminal", 8, 4),
            ("workstation-bookcase", 30, 4),
        ] {
            objects.push(prop(
                seed,
                objects.len(),
                MODULAR_WORKSTATION_DIGEST,
                key,
                x + dx,
                y + dy,
            ));
        }
        objects.push(prop(
            seed,
            objects.len(),
            WORKSHOP_DIGEST,
            "leafy-plant",
            x + 42,
            y + 4,
        ));
        for (key, dx, elevation) in [("mounted-frame", 2, 4), ("mounted-sconce", 38, 5)] {
            let mut object = prop(seed, objects.len(), MODULAR_MOUNTED_DIGEST, key, x + dx, y);
            mount(
                &mut object,
                if key == "mounted-sconce" {
                    ObjectKind::WallLight
                } else {
                    ObjectKind::Decoration
                },
                elevation,
            );
            objects.push(object);
        }
        // Only the northern rooms have an exterior back wall. No false windows
        // on the southern rooms' corridor partitions.
        if y < 0 {
            let mut window = prop(
                seed,
                objects.len(),
                MODULAR_MOUNTED_DIGEST,
                "mounted-window",
                x + 16,
                y,
            );
            mount(&mut window, ObjectKind::Window, 0);
            objects.push(window);
        }
    }
    // Functional objects sit on top of their supporting furniture. Preserve
    // relative order within each group; this is the normal editable prop stack.
    objects.sort_by_key(|object| object.extension.is_some());
    WorldLayout::new(map, objects).expect("starter placements retain wall and doorway support")
}
