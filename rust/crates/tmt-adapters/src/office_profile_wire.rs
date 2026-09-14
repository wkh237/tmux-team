//! Strict JSON representation for the core-owned local profile domain value.

use serde::Deserialize;
use serde_json::{Value, json};
use tmt_core::office_profile::{Appearance, LocalProfile};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AppearanceDocument {
    hair_style: String,
    hair_color: String,
    skin_tone: String,
    shirt_color: String,
    shirt_mark: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileDocument {
    display_label: String,
    description: String,
    appearance: AppearanceDocument,
}

pub fn decode_slice(bytes: &[u8]) -> Result<LocalProfile, ()> {
    let document: ProfileDocument = serde_json::from_slice(bytes).map_err(|_| ())?;
    decode(document)
}

pub fn decode_value(value: Value) -> Result<LocalProfile, ()> {
    let document: ProfileDocument = serde_json::from_value(value).map_err(|_| ())?;
    decode(document)
}

fn decode(document: ProfileDocument) -> Result<LocalProfile, ()> {
    let profile = LocalProfile {
        display_label: document.display_label,
        description: document.description,
        appearance: Appearance {
            hair_style: document.appearance.hair_style,
            hair_color: document.appearance.hair_color,
            skin_tone: document.appearance.skin_tone,
            shirt_color: document.appearance.shirt_color,
            shirt_mark: document.appearance.shirt_mark,
        },
    };
    profile.validate().map_err(|_| ())?;
    Ok(profile)
}

pub fn encode_value(profile: &LocalProfile) -> Value {
    json!({
        "displayLabel": profile.display_label,
        "description": profile.description,
        "appearance": {
            "hairStyle": profile.appearance.hair_style,
            "hairColor": profile.appearance.hair_color,
            "skinTone": profile.appearance.skin_tone,
            "shirtColor": profile.appearance.shirt_color,
            "shirtMark": profile.appearance.shirt_mark,
        }
    })
}
