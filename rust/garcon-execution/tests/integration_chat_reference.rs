use std::{cell::RefCell, io};

use async_trait::async_trait;
use garcon_cases::{CaseError, replay, text};
use garcon_chats::{
    registry_contracts::ChatRegistryEntry, registry_entry_codec::normalize_chat_registry_entry,
};
use garcon_contract::{
    agent_integration::{AgentSettingDescriptor, AgentSettingsEnvelope},
    transcript_seed::{NativeSeedPlacement, NativeSeedReceiptInput, create_native_seed_receipt},
};
use garcon_execution::integration_chat_reference::to_agent_chat_reference;
use garcon_interface::{resources::ExecutorResult, services::AgentSettings};
use garcon_js::json::Opaque;
use indexmap::IndexMap;
use serde_json::{Value, json};

struct Settings<'a> {
    effects: RefCell<Vec<&'static str>>,
    scenario: &'a str,
}

#[async_trait(?Send)]
impl AgentSettings for Settings<'_> {
    fn describe(&self) -> &[AgentSettingDescriptor] {
        &[]
    }

    fn defaults(&self) -> ExecutorResult<AgentSettingsEnvelope> {
        self.effects.borrow_mut().push("defaults");
        Ok(AgentSettingsEnvelope {
            owner_id: "test".into(),
            schema_version: 1,
            values: Opaque::from_value(json!({})),
        })
    }

    fn parse(&self, mut input: AgentSettingsEnvelope) -> ExecutorResult<AgentSettingsEnvelope> {
        self.effects.borrow_mut().push("parse");
        if self.scenario == "parse-fails" {
            return Err(io::Error::other("synthetic settings failure").into());
        }
        input.schema_version += 1;
        Ok(input)
    }

    async fn migrate(&self, input: AgentSettingsEnvelope) -> ExecutorResult<AgentSettingsEnvelope> {
        Ok(input)
    }

    fn apply_patch(
        &self,
        input: AgentSettingsEnvelope,
        _: IndexMap<String, Opaque>,
    ) -> ExecutorResult<AgentSettingsEnvelope> {
        Ok(input)
    }
}

fn entry(scenario: &str) -> ChatRegistryEntry {
    let mut raw = json!({
        "agentId": "test", "agentOwnershipEpoch": "owner", "projectPath": "/project",
        "agentSettingsById": {}, "parentChatId": null, "lineage": null,
        "carryOverSegments": [], "carryOverMigrationQuarantine": null, "nativeSeedReceipt": null,
    });
    match scenario {
        "defaults" => {}
        "seed" => {
            raw["model"] = json!("model");
            raw["agentSessionId"] = json!("native-1");
            raw["nativeSession"] =
                json!({ "ownerId":"test", "schemaVersion":1, "value": { "session":"synthetic" } });
            raw["nativeSeedReceipt"] = json!(
                create_native_seed_receipt(NativeSeedReceiptInput {
                    agent_session_id: "native-1",
                    placement: NativeSeedPlacement::UserPrefix,
                    prefix: "synthetic prefix",
                    format: None,
                })
                .unwrap()
            );
            raw["agentSettingsById"] = garcon_js::json::from_str(
                r#"{"test":{"ownerId":"test","schemaVersion":3,"values":{"n":1.0,"big":9007199254740993,"exp21":1e21,"zero":-0}}}"#,
            ).unwrap();
        }
        "empty-session" => raw["agentSessionId"] = json!(""),
        "mismatch" | "parse-fails" => {
            raw["agentId"] = json!("other");
            raw["nativeSession"] = json!({ "ownerId":"other", "schemaVersion":1, "value": {} });
        }
        _ => panic!("unknown chat reference scenario: {scenario}"),
    }
    normalize_chat_registry_entry(raw.as_object().unwrap(), "chat-1").unwrap()
}

fn trace(scenario: &str) -> Value {
    let settings = Settings {
        effects: RefCell::default(),
        scenario,
    };
    let (wire, error) = match to_agent_chat_reference(
        "test",
        &settings,
        "chat-1",
        &entry(scenario),
        "frozen-revision",
    ) {
        Ok(reference) => (Some(serde_json::to_string(&reference).unwrap()), None),
        Err(error) => (None, Some(error.to_string())),
    };
    json!({ "wire": wire, "error": error, "effects": *settings.effects.borrow() })
}

#[test]
fn chat_reference_keeps_the_captured_settings_and_native_session_binding() {
    replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/integration-chat-reference"
        ),
        |function, args| {
            if function != "integrationChatReferenceTrace" {
                return Err(CaseError::unhandled(function));
            }
            let scenario = text(function, args.first())?
                .ok_or_else(|| CaseError::undeliverable("missing chat reference scenario"))?;
            Ok(trace(scenario))
        },
    );
}
