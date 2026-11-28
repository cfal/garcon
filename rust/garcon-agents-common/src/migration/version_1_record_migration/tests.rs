use garcon_interface::services::{
    AgentLegacyExecutionDefaultsKind, AgentLegacyExecutionDefaultsScope, AgentLegacySettingsScope,
};
use garcon_js::json::{self, Opaque};

use super::*;
use crate::settings::versioned_settings::VersionedSettings;

fn settings(values: &str, descriptors: &str) -> Rc<dyn AgentSettings> {
    Rc::new(VersionedSettings::new(
        AgentSettingsEnvelope {
            owner_id: "synthetic-provider".into(),
            schema_version: 1,
            values: Opaque::parse(values).unwrap(),
        },
        json::from_str(descriptors).unwrap(),
        None,
    ))
}

fn legacy_settings(values: &str) -> AgentTranslateLegacySettingsRequest {
    AgentTranslateLegacySettingsRequest {
        scope: AgentLegacySettingsScope::ExecutionDefaults(AgentLegacyExecutionDefaultsScope {
            kind: AgentLegacyExecutionDefaultsKind::ExecutionDefaults,
            record_id: "synthetic".into(),
            selected_agent_id: None,
        }),
        legacy_values: json::from_str(values).unwrap(),
        signal: Default::default(),
    }
}

#[tokio::test]
async fn keeps_only_known_legacy_settings_and_returns_null_for_empty_ownership() {
    let migration = Version1RecordMigration {
        settings: settings(
            r#"{"mode":"default","enabled":true}"#,
            r#"[{"key":"enabled","label":"Enabled","type":"boolean"},{"key":"mode","label":"Mode","type":"string"}]"#,
        ),
        native_sessions: None,
        translate_model: None,
    };
    let result = migration
        .translate_legacy_settings(legacy_settings(r#"{"enabled":false,"unowned":5}"#))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_string(&result).unwrap(),
        r#"{"ownerId":"synthetic-provider","schemaVersion":1,"values":{"mode":"default","enabled":false}}"#
    );
    let migration = Version1RecordMigration {
        settings: settings("{}", "[]"),
        ..migration
    };
    assert_eq!(
        migration
            .translate_legacy_settings(legacy_settings(r#"{"unowned":5}"#))
            .await
            .unwrap(),
        None
    );
}
