//! Ports common/agent-settings.ts.

use std::borrow::Cow;

use garcon_js::json::{Opaque, as_number};
use serde_json::{Map, Value};

use crate::agent_integration::{AgentSettingDescriptor, AgentSettingKind, AgentSettingsEnvelope};

pub fn create_empty_agent_settings(owner_id: &str) -> AgentSettingsEnvelope {
    AgentSettingsEnvelope {
        owner_id: owner_id.to_owned(),
        schema_version: 1,
        values: Opaque::from_value(Value::Object(Map::new())),
    }
}

pub fn normalize_agent_settings(
    owner_id: &str,
    value: Option<&AgentSettingsEnvelope>,
    fallback: &AgentSettingsEnvelope,
) -> AgentSettingsEnvelope {
    clone_agent_settings(
        value
            .filter(|value| value.owner_id == owner_id)
            .unwrap_or(fallback),
    )
}

pub fn clone_agent_settings(value: &AgentSettingsEnvelope) -> AgentSettingsEnvelope {
    value.clone()
}

pub fn setting_value(
    envelope: &AgentSettingsEnvelope,
    descriptor: &AgentSettingDescriptor,
) -> Option<Opaque> {
    envelope
        .values
        .get(&descriptor.key)
        .cloned()
        .map(Opaque::from_value)
}

pub fn with_agent_setting<'a>(
    envelope: &'a AgentSettingsEnvelope,
    descriptor: &AgentSettingDescriptor,
    value: &Opaque,
) -> Cow<'a, AgentSettingsEnvelope> {
    if !is_descriptor_value(&descriptor.kind, value) {
        return Cow::Borrowed(envelope);
    }
    let mut entries = envelope.values.as_object().cloned().unwrap_or_default();
    entries.insert(descriptor.key.clone(), value.as_value().clone());
    Cow::Owned(AgentSettingsEnvelope {
        owner_id: envelope.owner_id.clone(),
        schema_version: envelope.schema_version,
        values: Opaque::from_value(Value::Object(entries)),
    })
}

fn is_descriptor_value(kind: &AgentSettingKind, value: &Value) -> bool {
    match kind {
        AgentSettingKind::Boolean => value.is_boolean(),
        AgentSettingKind::Enum { options } => value
            .as_str()
            .is_some_and(|value| options.iter().any(|option| option.value == value)),
        AgentSettingKind::Number { min, max, .. } => as_number(value)
            .is_some_and(|value| value.is_finite() && value >= min.0 && value <= max.0),
        AgentSettingKind::String | AgentSettingKind::CredentialRef { .. } => value.is_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_integration::AgentOption;
    use serde_json::json;

    fn effort() -> AgentSettingDescriptor {
        AgentSettingDescriptor {
            key: "effort".to_owned(),
            label: "Effort".to_owned(),
            label_key: None,
            kind: AgentSettingKind::Enum {
                options: [("low", "Low"), ("high", "High")]
                    .into_iter()
                    .map(|(value, label)| AgentOption {
                        value: value.to_owned(),
                        label: label.to_owned(),
                        label_key: None,
                        description: None,
                        description_key: None,
                    })
                    .collect(),
            },
        }
    }

    #[test]
    fn updates_declared_values_without_changing_the_envelope_identity_fields() {
        let initial = AgentSettingsEnvelope {
            schema_version: 2,
            values: Opaque::from_value(json!({"effort":"low"})),
            ..create_empty_agent_settings("sample")
        };
        let high = Opaque::from_value(json!("high"));
        let updated = with_agent_setting(&initial, &effort(), &high);
        assert_eq!(updated.owner_id, initial.owner_id);
        assert_eq!(updated.schema_version, 2);
        assert_eq!(setting_value(&updated, &effort()), Some(high));
        assert_eq!(initial.values["effort"], "low");
    }

    #[test]
    fn rejects_invalid_descriptor_values() {
        let initial = create_empty_agent_settings("sample");
        let invalid = Opaque::from_value(json!("maximum"));
        assert!(matches!(with_agent_setting(&initial, &effort(), &invalid),
            Cow::Borrowed(result) if std::ptr::eq(result, &initial)));
    }

    #[test]
    fn falls_back_instead_of_accepting_settings_owned_by_another_integration() {
        let fallback = AgentSettingsEnvelope {
            values: Opaque::from_value(json!({"effort":"low"})),
            ..create_empty_agent_settings("sample")
        };
        let mismatched = create_empty_agent_settings("other");
        assert_eq!(
            normalize_agent_settings("sample", Some(&mismatched), &fallback),
            fallback
        );
        assert_eq!(
            normalize_agent_settings("sample", None, &fallback),
            fallback
        );
        assert_eq!(
            serde_json::to_string(&create_empty_agent_settings("sample")).unwrap(),
            r#"{"ownerId":"sample","schemaVersion":1,"values":{}}"#
        );
    }
}
