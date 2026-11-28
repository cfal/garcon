use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const CLI_PRESET_PRESENTATION_STYLES: &[&str] = &["info", "notice", "error"];
pub const CLI_PRESENTATION_STYLES: &[&str] = &["info", "notice", "error", "custom"];
pub const CLI_PRESENTATION_STYLE_LIST: &str = "info, notice, error, custom";
pub const CLI_ROW_FORMATS: &[&str] = &["plain", "markdown"];
pub const CLI_BODY_DISCLOSURES: &[&str] = &["expanded", "collapsed"];

pub type HexColor = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CliPresetPresentationStyle {
    Info,
    Notice,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CliPresentationStyle {
    Info,
    Notice,
    Error,
    Custom,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliCustomStyle {
    pub light_accent: HexColor,
    pub dark_accent: HexColor,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "style", rename_all = "lowercase")]
pub enum CliPresentation {
    Info,
    Notice,
    Error,
    Custom {
        #[serde(rename = "customStyle")]
        custom_style: CliCustomStyle,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CliRowFormat {
    Plain,
    Markdown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CliBodyDisclosure {
    Expanded,
    Collapsed,
}

pub fn is_cli_presentation_style(value: &Value) -> Option<CliPresentationStyle> {
    match value.as_str()? {
        "info" => Some(CliPresentationStyle::Info),
        "notice" => Some(CliPresentationStyle::Notice),
        "error" => Some(CliPresentationStyle::Error),
        "custom" => Some(CliPresentationStyle::Custom),
        _ => None,
    }
}

pub fn is_cli_preset_presentation_style(value: &Value) -> Option<CliPresetPresentationStyle> {
    match is_cli_presentation_style(value)? {
        CliPresentationStyle::Info => Some(CliPresetPresentationStyle::Info),
        CliPresentationStyle::Notice => Some(CliPresetPresentationStyle::Notice),
        CliPresentationStyle::Error => Some(CliPresetPresentationStyle::Error),
        CliPresentationStyle::Custom => None,
    }
}

pub fn is_hex_color(value: &Value) -> bool {
    value
        .as_str()
        .and_then(|value| value.strip_prefix('#'))
        .is_some_and(|hex| {
            hex.len() == 6
                && hex
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
}

pub fn normalize_cli_hex_color(value: &str) -> Option<HexColor> {
    let hex = value.strip_prefix('#').unwrap_or(value);
    (hex.len() == 6 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| format!("#{}", hex.to_ascii_lowercase()))
}

pub fn is_cli_custom_style(value: &Value) -> Option<CliCustomStyle> {
    let object = value.as_object()?;
    if object.len() != 2 {
        return None;
    }
    let light_accent = object.get("lightAccent")?;
    let dark_accent = object.get("darkAccent")?;
    if !is_hex_color(light_accent) || !is_hex_color(dark_accent) {
        return None;
    }
    Some(CliCustomStyle {
        light_accent: light_accent.as_str()?.into(),
        dark_accent: dark_accent.as_str()?.into(),
    })
}

pub fn is_cli_presentation(value: &Value) -> Option<CliPresentation> {
    let object = value.as_object()?;
    let style = is_cli_presentation_style(object.get("style")?)?;
    if style != CliPresentationStyle::Custom {
        return (object.len() == 1).then(|| preset_presentation(style));
    }
    if object.len() != 2 {
        return None;
    }
    Some(CliPresentation::Custom {
        custom_style: is_cli_custom_style(object.get("customStyle")?)?,
    })
}

pub fn is_cli_row_format(value: &Value) -> Option<CliRowFormat> {
    match value.as_str()? {
        "plain" => Some(CliRowFormat::Plain),
        "markdown" => Some(CliRowFormat::Markdown),
        _ => None,
    }
}

pub fn is_cli_body_disclosure(value: &Value) -> Option<CliBodyDisclosure> {
    match value.as_str()? {
        "expanded" => Some(CliBodyDisclosure::Expanded),
        "collapsed" => Some(CliBodyDisclosure::Collapsed),
        _ => None,
    }
}

pub fn coerce_durable_cli_body_disclosure(value: &Value) -> CliBodyDisclosure {
    is_cli_body_disclosure(value).unwrap_or(CliBodyDisclosure::Expanded)
}

pub fn coerce_durable_cli_presentation(value: &Value) -> CliPresentation {
    if let Some(presentation) = is_cli_presentation(value) {
        return presentation;
    }
    if let Some(style) = is_cli_presentation_style(value) {
        return preset_presentation(style);
    }
    let fallback = CliPresentation::Notice;
    let Some(object) = value.as_object() else {
        return fallback;
    };
    let Some(style) = object.get("style").and_then(is_cli_presentation_style) else {
        return fallback;
    };
    match object.get("customStyle") {
        Some(custom) if style == CliPresentationStyle::Custom => is_cli_custom_style(custom)
            .map_or(fallback, |custom_style| CliPresentation::Custom {
                custom_style,
            }),
        None => preset_presentation(style),
        Some(_) => fallback,
    }
}

fn preset_presentation(style: CliPresentationStyle) -> CliPresentation {
    match style {
        CliPresentationStyle::Info => CliPresentation::Info,
        CliPresentationStyle::Notice | CliPresentationStyle::Custom => CliPresentation::Notice,
        CliPresentationStyle::Error => CliPresentation::Error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_cli_hex_input_to_the_strict_durable_form() {
        assert_eq!(
            normalize_cli_hex_color("7C3AED").as_deref(),
            Some("#7c3aed")
        );
        assert_eq!(
            normalize_cli_hex_color("#C4B5FD").as_deref(),
            Some("#c4b5fd")
        );
        for value in ["fff", "#1234567", "red", "#ff0000\n"] {
            assert!(normalize_cli_hex_color(value).is_none());
        }
    }

    #[test]
    fn validates_and_safely_defaults_durable_body_disclosure() {
        assert_eq!(
            is_cli_body_disclosure(&json!("collapsed")),
            Some(CliBodyDisclosure::Collapsed)
        );
        assert_eq!(is_cli_body_disclosure(&json!("hidden")), None);
        assert_eq!(
            coerce_durable_cli_body_disclosure(&json!("collapsed")),
            CliBodyDisclosure::Collapsed
        );
        assert_eq!(
            coerce_durable_cli_body_disclosure(&Value::Null),
            CliBodyDisclosure::Expanded
        );
    }

    #[test]
    fn accepts_only_valid_preset_and_discriminated_custom_presentations() {
        assert!(is_cli_presentation(&json!({"style": "notice"})).is_some());
        assert!(is_cli_presentation(&custom()).is_some());
        for value in [
            json!({"style": "custom"}),
            json!({"style": "custom", "customStyle": {"lightAccent": "#7C3AED", "darkAccent": "#c4b5fd"}}),
            json!({"style": "notice", "customStyle": {}}),
        ] {
            assert!(is_cli_presentation(&value).is_none());
        }
    }

    #[test]
    fn preserves_valid_durable_presentation_and_degrades_malformed_custom_values() {
        let custom = custom();
        assert_eq!(json!(coerce_durable_cli_presentation(&custom)), custom);
        assert_eq!(
            coerce_durable_cli_presentation(&json!("error")),
            CliPresentation::Error
        );
        assert_eq!(
            coerce_durable_cli_presentation(&json!({"style": "error", "ignored": true})),
            CliPresentation::Error
        );
        assert_eq!(
            coerce_durable_cli_presentation(&json!({"style": "custom", "customStyle": {}})),
            CliPresentation::Notice
        );
    }

    fn custom() -> Value {
        json!({"style": "custom", "customStyle": {"lightAccent": "#7c3aed", "darkAccent": "#c4b5fd"}})
    }
}
