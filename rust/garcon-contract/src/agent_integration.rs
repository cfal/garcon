//! Ports `common/agent-integration.ts`.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use garcon_js::{Number, is_safe_integer};

use crate::api_providers::ApiProtocol;
use crate::chat_modes::{PermissionMode, ThinkingMode};
use crate::json::JsonObject;

/// What an integration declares about itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDescriptor {
    pub id: String,
    pub label: String,
    /// The name of the integration's icon, or `None` when it has none.
    pub icon: Option<String>,
    pub supported_permission_modes: Vec<PermissionMode>,
    pub supported_thinking_modes: Vec<ThinkingMode>,
    pub supports_images: bool,
    pub supports_project_path_update: bool,
    pub requires_native_path_for_project_path_update: bool,
    pub supported_endpoint_protocols: Vec<ApiProtocol>,
    pub configuration: Vec<AgentConfigurationDescriptor>,
}

/// A setting an integration reads from where it runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigurationDescriptor {
    pub key: String,
    pub source: AgentConfigurationSource,
    pub description: String,
}

/// Where an integration reads a setting from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AgentConfigurationSource {
    #[serde(rename = "environment")]
    Environment,
}

/// The settings a chat holds for one agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettingsEnvelope {
    pub owner_id: String,
    pub schema_version: i64,
    pub values: JsonObject,
}

/// The label keys a setting can have.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentSettingLabelKey {
    Thinking,
    Mode,
    Speed,
}

impl AgentSettingLabelKey {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentSettingLabelKey::Thinking => "thinking",
            AgentSettingLabelKey::Mode => "mode",
            AgentSettingLabelKey::Speed => "speed",
        }
    }
}

pub const AGENT_SETTING_LABEL_KEYS: &[AgentSettingLabelKey] = &[
    AgentSettingLabelKey::Thinking,
    AgentSettingLabelKey::Mode,
    AgentSettingLabelKey::Speed,
];

/// The label keys an option can have.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentSettingOptionLabelKey {
    Automatic,
    Enabled,
    Disabled,
}

impl AgentSettingOptionLabelKey {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentSettingOptionLabelKey::Automatic => "automatic",
            AgentSettingOptionLabelKey::Enabled => "enabled",
            AgentSettingOptionLabelKey::Disabled => "disabled",
        }
    }
}

pub const AGENT_SETTING_OPTION_LABEL_KEYS: &[AgentSettingOptionLabelKey] = &[
    AgentSettingOptionLabelKey::Automatic,
    AgentSettingOptionLabelKey::Enabled,
    AgentSettingOptionLabelKey::Disabled,
];

/// The description keys an option can have.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentSettingOptionDescriptionKey {
    ThinkingAutomatic,
    ThinkingEnabled,
    ThinkingDisabled,
}

impl AgentSettingOptionDescriptionKey {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentSettingOptionDescriptionKey::ThinkingAutomatic => "thinkingAutomatic",
            AgentSettingOptionDescriptionKey::ThinkingEnabled => "thinkingEnabled",
            AgentSettingOptionDescriptionKey::ThinkingDisabled => "thinkingDisabled",
        }
    }
}

pub const AGENT_SETTING_OPTION_DESCRIPTION_KEYS: &[AgentSettingOptionDescriptionKey] = &[
    AgentSettingOptionDescriptionKey::ThinkingAutomatic,
    AgentSettingOptionDescriptionKey::ThinkingEnabled,
    AgentSettingOptionDescriptionKey::ThinkingDisabled,
];

/// One value an enum setting can take.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOption {
    pub value: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_key: Option<AgentSettingOptionLabelKey>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description_key: Option<AgentSettingOptionDescriptionKey>,
}

/// A setting an integration exposes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSettingDescriptor {
    pub key: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_key: Option<AgentSettingLabelKey>,
    #[serde(flatten)]
    pub kind: AgentSettingKind,
}

/// What a setting holds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum AgentSettingKind {
    Boolean,
    Enum {
        options: Vec<AgentOption>,
    },
    Number {
        min: Number,
        max: Number,
        step: Number,
    },
    String,
    CredentialRef {
        credential_kind: String,
    },
}

/// Whether `value` is the label key of a setting.
pub fn is_agent_setting_label_key(value: &Value) -> Option<AgentSettingLabelKey> {
    let text = value.as_str()?;
    AGENT_SETTING_LABEL_KEYS
        .iter()
        .copied()
        .find(|key| key.as_str() == text)
}

/// Whether `value` is the label key of an option.
pub fn is_agent_setting_option_label_key(value: &Value) -> Option<AgentSettingOptionLabelKey> {
    let text = value.as_str()?;
    AGENT_SETTING_OPTION_LABEL_KEYS
        .iter()
        .copied()
        .find(|key| key.as_str() == text)
}

/// Whether `value` is the description key of an option.
pub fn is_agent_setting_option_description_key(
    value: &Value,
) -> Option<AgentSettingOptionDescriptionKey> {
    let text = value.as_str()?;
    AGENT_SETTING_OPTION_DESCRIPTION_KEYS
        .iter()
        .copied()
        .find(|key| key.as_str() == text)
}

/// What an executor reports about an integration and its settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCatalogDescriptor {
    pub descriptor: AgentDescriptor,
    pub settings: Vec<AgentSettingDescriptor>,
}

// A JSON number the original checks with `Number.isSafeInteger`, which a
// JSON `1.0` passes.
fn safe_integer(value: &Value) -> Option<i64> {
    garcon_js::json::as_number(value)
        .filter(|number| is_safe_integer(*number))
        .map(|number| number as i64)
}

/// Reads the settings a chat holds for one agent, or `None` when they are
/// not shaped as the original expects.
pub fn parse_agent_settings_envelope(value: &Value) -> Option<AgentSettingsEnvelope> {
    let envelope = value.as_object()?;
    let owner_id = envelope
        .get("ownerId")
        .and_then(Value::as_str)
        .filter(|owner_id| !owner_id.is_empty())?;
    let schema_version =
        safe_integer(envelope.get("schemaVersion")?).filter(|version| *version >= 1)?;
    // `values` must hold JSON only, which a parsed value always does.
    let values = envelope.get("values")?.as_object()?;
    Some(AgentSettingsEnvelope {
        owner_id: owner_id.to_owned(),
        schema_version,
        values: values.clone(),
    })
}

/// Reads the settings each agent of a chat holds, by agent ID, or `None`
/// when one is not shaped as the original expects or belongs to another
/// owner than its key says.
pub fn parse_agent_settings_by_id(
    value: &Value,
) -> Option<IndexMap<String, AgentSettingsEnvelope>> {
    let settings = value.as_object()?;
    let mut parsed = IndexMap::with_capacity(settings.len());
    for (agent_id, candidate) in settings {
        let envelope = parse_agent_settings_envelope(candidate)?;
        if envelope.owner_id != *agent_id {
            return None;
        }
        parsed.insert(agent_id.clone(), envelope);
    }
    Some(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn envelope(owner_id: &str, schema_version: i64) -> AgentSettingsEnvelope {
        AgentSettingsEnvelope {
            owner_id: owner_id.to_owned(),
            schema_version,
            values: JsonObject::new(),
        }
    }

    #[test]
    fn reads_a_settings_envelope() {
        let value = json!({ "ownerId": "chat-1", "schemaVersion": 2, "values": { "a": [1, "x"] } });
        assert_eq!(
            parse_agent_settings_envelope(&value),
            Some(AgentSettingsEnvelope {
                owner_id: "chat-1".to_owned(),
                schema_version: 2,
                values: json!({ "a": [1, "x"] }).as_object().unwrap().clone(),
            })
        );
        // A JSON `1.0` is the safe integer 1, as the original reads it.
        assert_eq!(
            parse_agent_settings_envelope(
                &json!({ "ownerId": "c", "schemaVersion": 1.0, "values": {} })
            ),
            Some(envelope("c", 1))
        );
        // The schema version is read first, so a broken one is reported
        // before the values are looked at.
        for (value, because) in [
            (json!(null), "no record"),
            (json!([]), "no record"),
            (json!({ "schemaVersion": 1, "values": {} }), "no owner"),
            (
                json!({ "ownerId": "", "schemaVersion": 1, "values": {} }),
                "empty owner",
            ),
            (
                json!({ "ownerId": 5, "schemaVersion": 1, "values": {} }),
                "owner not a string",
            ),
            (json!({ "ownerId": "c", "values": {} }), "no schema version"),
            (
                json!({ "ownerId": "c", "schemaVersion": 0, "values": {} }),
                "schema version 0",
            ),
            (
                json!({ "ownerId": "c", "schemaVersion": -1, "values": {} }),
                "negative schema version",
            ),
            (
                json!({ "ownerId": "c", "schemaVersion": 1.5, "values": {} }),
                "fractional schema version",
            ),
            (
                json!({ "ownerId": "c", "schemaVersion": "1", "values": {} }),
                "schema version not a number",
            ),
            (
                json!({ "ownerId": "c", "schemaVersion": null, "values": {} }),
                "schema version null",
            ),
            (
                json!({ "ownerId": "c", "schemaVersion": 9007199254740992u64, "values": {} }),
                "schema version beyond the safe range",
            ),
            (json!({ "ownerId": "c", "schemaVersion": 1 }), "no values"),
            (
                json!({ "ownerId": "c", "schemaVersion": 1, "values": null }),
                "values null",
            ),
            (
                json!({ "ownerId": "c", "schemaVersion": 1, "values": [] }),
                "values an array",
            ),
            (
                json!({ "ownerId": "c", "schemaVersion": 1, "values": "x" }),
                "values a string",
            ),
        ] {
            assert_eq!(
                parse_agent_settings_envelope(&value),
                None,
                "{because}: {value}"
            );
        }
        // Other fields are left alone.
        assert_eq!(
            parse_agent_settings_envelope(
                &json!({ "ownerId": "c", "schemaVersion": 1, "values": {}, "extra": true })
            ),
            Some(envelope("c", 1))
        );
        // A value that is not JSON cannot arrive here, so `values` is only
        // checked to be an object.
        let values = json!({ "n": 1.5, "deep": [null, true, { "s": "x" }] });
        let parsed = parse_agent_settings_envelope(&json!({
            "ownerId": "c",
            "schemaVersion": 1,
            "values": values,
        }))
        .unwrap();
        assert_eq!(parsed.values, values.as_object().unwrap().clone());
    }

    #[test]
    fn reads_the_settings_of_each_agent() {
        let value = json!({ "claude": { "ownerId": "claude", "schemaVersion": 1, "values": {} }, "codex": { "ownerId": "codex", "schemaVersion": 3, "values": {} } });
        let parsed = parse_agent_settings_by_id(&value).unwrap();
        assert_eq!(
            parsed.into_iter().collect::<Vec<_>>(),
            [
                ("claude".to_owned(), envelope("claude", 1)),
                ("codex".to_owned(), envelope("codex", 3)),
            ]
        );
        assert_eq!(parse_agent_settings_by_id(&json!({})).unwrap().len(), 0);
        // An owner that is not the agent's own key rejects the whole record.
        assert_eq!(
            parse_agent_settings_by_id(
                &json!({ "claude": { "ownerId": "codex", "schemaVersion": 1, "values": {} } })
            ),
            None
        );
        // One broken envelope rejects the whole record, whichever comes first.
        assert_eq!(
            parse_agent_settings_by_id(&json!({
                "claude": { "ownerId": "claude", "schemaVersion": 1, "values": {} },
                "codex": { "ownerId": "codex" },
            })),
            None
        );
        for value in [json!(null), json!([]), json!("x"), json!(5)] {
            assert_eq!(parse_agent_settings_by_id(&value), None, "{value}");
        }
    }

    #[test]
    fn recognizes_the_label_and_description_keys() {
        for (key, name) in [
            (AgentSettingLabelKey::Thinking, "thinking"),
            (AgentSettingLabelKey::Mode, "mode"),
            (AgentSettingLabelKey::Speed, "speed"),
        ] {
            assert_eq!(is_agent_setting_label_key(&json!(name)), Some(key));
            assert_eq!(serde_json::to_value(key).unwrap(), json!(name));
        }
        for (key, name) in [
            (AgentSettingOptionLabelKey::Automatic, "automatic"),
            (AgentSettingOptionLabelKey::Enabled, "enabled"),
            (AgentSettingOptionLabelKey::Disabled, "disabled"),
        ] {
            assert_eq!(is_agent_setting_option_label_key(&json!(name)), Some(key));
            assert_eq!(serde_json::to_value(key).unwrap(), json!(name));
        }
        for (key, name) in [
            (
                AgentSettingOptionDescriptionKey::ThinkingAutomatic,
                "thinkingAutomatic",
            ),
            (
                AgentSettingOptionDescriptionKey::ThinkingEnabled,
                "thinkingEnabled",
            ),
            (
                AgentSettingOptionDescriptionKey::ThinkingDisabled,
                "thinkingDisabled",
            ),
        ] {
            assert_eq!(
                is_agent_setting_option_description_key(&json!(name)),
                Some(key)
            );
            assert_eq!(serde_json::to_value(key).unwrap(), json!(name));
        }
        for value in [
            json!("Thinking"),
            json!("thinking "),
            json!("thinkingautomatic"),
            json!(""),
            json!(null),
            json!(5),
            json!(true),
            json!([]),
            json!({}),
        ] {
            assert!(is_agent_setting_label_key(&value).is_none(), "{value}");
            assert!(
                is_agent_setting_option_label_key(&value).is_none(),
                "{value}"
            );
            assert!(
                is_agent_setting_option_description_key(&value).is_none(),
                "{value}"
            );
        }
        // Each list holds only its own keys.
        assert!(is_agent_setting_label_key(&json!("automatic")).is_none());
        assert!(is_agent_setting_option_label_key(&json!("thinking")).is_none());
        assert!(is_agent_setting_option_description_key(&json!("enabled")).is_none());
    }

    #[test]
    fn reads_and_writes_a_descriptor_in_the_original_shape() {
        let settings = json!([
            { "key": "effort", "label": "Effort", "type": "enum", "options": [
                { "value": "high", "label": "High", "labelKey": "enabled", "descriptionKey": "thinkingEnabled" },
                { "value": "low", "label": "Low", "description": "Less" },
            ] },
            { "key": "speed", "label": "Speed", "labelKey": "speed", "type": "number", "min": 0, "max": 10, "step": 0.5 },
            { "key": "flag", "label": "Flag", "type": "boolean" },
            { "key": "name", "label": "Name", "type": "string" },
            { "key": "key", "label": "Key", "type": "credential-ref", "credentialKind": "api-key" },
        ]);
        let descriptor = json!({
            "id": "claude",
            "label": "Claude",
            "icon": null,
            "supportedPermissionModes": ["default", "plan"],
            "supportedThinkingModes": ["none", "xhigh"],
            "supportsImages": true,
            "supportsProjectPathUpdate": true,
            "requiresNativePathForProjectPathUpdate": false,
            "supportedEndpointProtocols": ["anthropic-messages"],
            "configuration": [{ "key": "token", "source": "environment", "description": "A token" }],
        });
        let catalog: AgentCatalogDescriptor =
            serde_json::from_value(json!({ "descriptor": descriptor, "settings": settings }))
                .unwrap();
        let AgentSettingKind::Number { min, max, step } = catalog.settings[1].kind else {
            panic!("the second setting is a number: {:?}", catalog.settings[1]);
        };
        assert!(
            (min.0, max.0, step.0) == (0.0, 10.0, 0.5),
            "{:?}",
            catalog.settings[1]
        );
        // A number is written as JavaScript writes it, and an absent optional
        // property stays absent.
        assert_eq!(
            serde_json::to_string(&catalog).unwrap(),
            [
                r#"{"descriptor":{"id":"claude","label":"Claude","icon":null,"supportedPermissionModes":["default","plan"],"#,
                r#""supportedThinkingModes":["none","xhigh"],"supportsImages":true,"supportsProjectPathUpdate":true,"#,
                r#""requiresNativePathForProjectPathUpdate":false,"supportedEndpointProtocols":["anthropic-messages"],"#,
                r#""configuration":[{"key":"token","source":"environment","description":"A token"}]},"settings":["#,
                r#"{"key":"effort","label":"Effort","type":"enum","options":[{"value":"high","label":"High","labelKey":"enabled","#,
                r#""descriptionKey":"thinkingEnabled"},{"value":"low","label":"Low","description":"Less"}]},"#,
                r#"{"key":"speed","label":"Speed","labelKey":"speed","type":"number","min":0,"max":10,"step":0.5},"#,
                r#"{"key":"flag","label":"Flag","type":"boolean"},{"key":"name","label":"Name","type":"string"},"#,
                r#"{"key":"key","label":"Key","type":"credential-ref","credentialKind":"api-key"}]}"#,
            ]
            .concat()
        );
        // A descriptor of no known kind, or a setting source other than the
        // environment, is not read.
        assert!(
            serde_json::from_value::<AgentSettingDescriptor>(
                json!({ "key": "k", "label": "l", "type": "color" })
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<AgentSettingDescriptor>(
                json!({ "key": "k", "label": "l", "type": "number", "min": 0, "max": 1 })
            )
            .is_err()
        );
        assert!(
            serde_json::from_value::<AgentConfigurationDescriptor>(
                json!({ "key": "k", "source": "file", "description": "d" })
            )
            .is_err()
        );
    }
}
