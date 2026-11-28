//! Ports `common/agents.ts`.

use std::sync::LazyLock;

use garcon_js::Number;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent_integration::{AgentSettingDescriptor, AgentSettingsEnvelope};
use crate::api_providers::{ApiProtocol, ApiProviderCatalogEntry};
use crate::attachments::FileAttachmentMimeTypes;
use crate::chat_modes::{PermissionMode, ThinkingMode};
use crate::input_format::{InputFormatByModel, is_input_format_by_model};

pub const DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID: &str = "direct-openai-compatible";
pub const DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID: &str = "direct-openai-responses-compatible";
pub const DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID: &str = "direct-anthropic-compatible";
pub const DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_LABEL: &str = "Direct (Chat Completions)";
pub const DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_LABEL: &str = "Direct (Responses)";
pub const DIRECT_ANTHROPIC_COMPATIBLE_AGENT_LABEL: &str = "Direct (Anthropic)";
pub const DEFAULT_AGENT_ID: &str = "claude";

pub type AgentId = String;

/// A model an agent runs, as the clients list it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModelOption {
    pub value: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_images: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_local: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<ApiProtocol>,
}

/// What a catalog entry describes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentCatalogEntryKind {
    Agent,
}

/// Whether an agent runs a whole conversation or one prompt at a time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentExecutionPolicy {
    Conversation,
    Literal,
}

/// The model an agent is placed in when several are listed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentGeneration {
    pub priority: Number,
    pub model: String,
}

/// What the clients see of an agent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCatalogEntry {
    pub id: AgentId,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub kind: AgentCatalogEntryKind,
    pub execution_policy: AgentExecutionPolicy,
    pub selection_label: String,
    pub input_format_by_model: InputFormatByModel,
    pub supports_compact: bool,
    pub supports_fork: bool,
    pub supports_fork_at_message: bool,
    pub supports_fork_while_running: bool,
    pub supports_update_project_path: bool,
    pub supports_steering: bool,
    pub supports_images: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_attachment_mime_types: Option<FileAttachmentMimeTypes>,
    pub accepts_api_provider_endpoints: bool,
    pub supported_protocols: Vec<ApiProtocol>,
    pub auth_login_supported: bool,
    pub supported_permission_modes: Vec<PermissionMode>,
    pub supported_thinking_modes: Vec<ThinkingMode>,
    pub settings: Vec<AgentSettingDescriptor>,
    pub default_settings: AgentSettingsEnvelope,
    pub requires_strict_model_discovery: bool,
    /// `None` is `null`: the agent is not placed in a generation.
    pub generation: Option<AgentGeneration>,
    pub default_model: String,
    pub models: Vec<AgentModelOption>,
}

/// The agents and the API providers the clients can choose from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCatalog {
    pub agents: Vec<AgentCatalogEntry>,
    pub api_providers: Vec<ApiProviderCatalogEntry>,
}

static SAFE_ID_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9_-]{1,63}$").expect("SAFE_ID_RE compiles"));

/// Whether `value` is the ID of an agent: two to sixty-four lower-case
/// letters, digits, underscores, or hyphens, the first of them a letter.
pub fn is_agent_id(value: &Value) -> bool {
    value.as_str().is_some_and(|id| SAFE_ID_RE.is_match(id))
}

/// Whether `value` already says how a chat executes the agent: its execution
/// policy, its selection label, and the input format of each of its models.
pub fn has_agent_execution_metadata(value: &Value) -> bool {
    let Some(metadata) = value.as_object() else {
        return false;
    };
    is_execution_policy(metadata.get("executionPolicy"))
        && metadata
            .get("selectionLabel")
            .and_then(Value::as_str)
            .is_some_and(|label| !label.is_empty())
        && is_input_format_by_model(metadata.get("inputFormatByModel").unwrap_or(&Value::Null))
}

fn is_execution_policy(value: Option<&Value>) -> bool {
    matches!(
        value.and_then(Value::as_str),
        Some("conversation" | "literal")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn metadata() -> serde_json::Value {
        json!({
            "executionPolicy": "conversation",
            "selectionLabel": "Claude",
            "inputFormatByModel": { "claude-sonnet": "plain" },
        })
    }

    #[test]
    fn reads_an_agent_id() {
        for valid in [
            "ab",
            "claude",
            "codex",
            "a-b_c9",
            "direct-openai-compatible",
            "opencode",
        ] {
            assert!(is_agent_id(&json!(valid)), "{valid}");
        }
        // Sixty-four characters is the longest ID.
        assert!(is_agent_id(&json!(format!("a{}", "b".repeat(63)))));
        assert!(!is_agent_id(&json!(format!("a{}", "b".repeat(64)))));
        for invalid in [
            json!(""),
            json!("a"),
            json!("Claude"),
            json!("1ab"),
            json!("-ab"),
            json!("_ab"),
            json!("aB"),
            json!("a.b"),
            json!("a b"),
            json!("ab "),
            json!("é"),
            json!("\u{0131}"),
            json!("\u{212A}"),
            json!("ab\n"),
            json!(5),
            json!(null),
            json!(true),
            json!([]),
            json!({}),
        ] {
            assert!(!is_agent_id(&invalid), "{invalid}");
        }
        assert_eq!(DEFAULT_AGENT_ID, "claude");
        assert_eq!(
            DIRECT_ANTHROPIC_COMPATIBLE_AGENT_LABEL,
            "Direct (Anthropic)"
        );
    }

    #[test]
    fn recognizes_execution_metadata() {
        assert!(has_agent_execution_metadata(&metadata()));
        // Other fields do not matter, and an empty map of formats is a map.
        let literal = json!({
            "executionPolicy": "literal",
            "selectionLabel": "Shell",
            "inputFormatByModel": {},
            "supportsImages": true,
        });
        assert!(has_agent_execution_metadata(&literal));
    }

    #[test]
    fn rejects_incomplete_execution_metadata() {
        for (field, value) in [
            ("executionPolicy", json!("unknown")),
            ("executionPolicy", json!("Conversation")),
            ("executionPolicy", json!(null)),
            ("executionPolicy", json!(5)),
            ("selectionLabel", json!("")),
            ("selectionLabel", json!(null)),
            ("selectionLabel", json!(5)),
            ("selectionLabel", json!(["Claude"])),
            ("inputFormatByModel", json!({ "m": "html" })),
            ("inputFormatByModel", json!({ "": "plain" })),
            ("inputFormatByModel", json!(null)),
            ("inputFormatByModel", json!("markdown")),
            ("inputFormatByModel", json!([])),
        ] {
            let mut incomplete = metadata();
            incomplete[field] = value.clone();
            assert!(
                !has_agent_execution_metadata(&incomplete),
                "{field}: {value}"
            );
            let mut missing = metadata();
            missing.as_object_mut().unwrap().shift_remove(field);
            assert!(!has_agent_execution_metadata(&missing), "without {field}");
        }
        // A selection label is checked for being non-empty, not for being trimmed.
        assert!(has_agent_execution_metadata(&json!({
            "executionPolicy": "literal",
            "selectionLabel": " ",
            "inputFormatByModel": {},
        })));
        for value in [json!(null), json!([]), json!("x"), json!(5), json!(true)] {
            assert!(!has_agent_execution_metadata(&value), "{value}");
        }
    }

    #[test]
    fn reads_and_writes_a_catalog_entry_in_the_original_shape() {
        let entry = json!({
            "id": "claude",
            "label": "Claude",
            "kind": "agent",
            "executionPolicy": "conversation",
            "selectionLabel": "Claude",
            "inputFormatByModel": {},
            "supportsCompact": true,
            "supportsFork": true,
            "supportsForkAtMessage": false,
            "supportsForkWhileRunning": false,
            "supportsUpdateProjectPath": false,
            "supportsSteering": true,
            "supportsImages": true,
            "acceptsApiProviderEndpoints": true,
            "supportedProtocols": ["anthropic-messages"],
            "authLoginSupported": true,
            "supportedPermissionModes": ["default", "acceptEdits", "plan"],
            "supportedThinkingModes": ["none", "low", "high"],
            "settings": [{ "key": "effort", "label": "Effort", "type": "string" }],
            "defaultSettings": { "ownerId": "chat", "schemaVersion": 1, "values": {} },
            "requiresStrictModelDiscovery": false,
            "generation": null,
            "defaultModel": "claude-sonnet",
            "models": [{ "value": "claude-sonnet", "label": "Sonnet", "supportsImages": true }],
        });
        let parsed: AgentCatalogEntry = serde_json::from_value(entry.clone()).unwrap();
        assert_eq!(parsed.generation, None);
        assert_eq!(parsed.description, None);
        assert_eq!(
            serde_json::to_string(&parsed).unwrap(),
            serde_json::to_string(&entry).unwrap()
        );

        // An optional description and file types are written when they are
        // set, and a generation is written with its priority as JavaScript
        // writes it.
        let described = json!({
            "id": "shell",
            "label": "Shell",
            "description": "Runs commands",
            "kind": "agent",
            "executionPolicy": "literal",
            "selectionLabel": "Shell",
            "inputFormatByModel": { "shell": "markdown" },
            "supportsCompact": false,
            "supportsFork": false,
            "supportsForkAtMessage": false,
            "supportsForkWhileRunning": false,
            "supportsUpdateProjectPath": true,
            "supportsSteering": false,
            "supportsImages": false,
            "fileAttachmentMimeTypes": "any",
            "acceptsApiProviderEndpoints": false,
            "supportedProtocols": [],
            "authLoginSupported": false,
            "supportedPermissionModes": ["default"],
            "supportedThinkingModes": [],
            "settings": [],
            "defaultSettings": { "ownerId": "chat", "schemaVersion": 1, "values": {} },
            "requiresStrictModelDiscovery": true,
            "generation": { "priority": 1, "model": "claude-sonnet" },
            "defaultModel": "shell",
            "models": [{ "value": "shell", "label": "Shell", "isLocal": true }],
        });
        let parsed: AgentCatalogEntry = serde_json::from_value(described.clone()).unwrap();
        assert_eq!(
            parsed.file_attachment_mime_types,
            Some(FileAttachmentMimeTypes::Any)
        );
        assert_eq!(
            serde_json::to_string(&parsed).unwrap(),
            [
                r#"{"id":"shell","label":"Shell","description":"Runs commands","kind":"agent","executionPolicy":"literal","#,
                r#""selectionLabel":"Shell","inputFormatByModel":{"shell":"markdown"},"supportsCompact":false,"supportsFork":false,"#,
                r#""supportsForkAtMessage":false,"supportsForkWhileRunning":false,"supportsUpdateProjectPath":true,"supportsSteering":false,"#,
                r#""supportsImages":false,"fileAttachmentMimeTypes":"any","acceptsApiProviderEndpoints":false,"supportedProtocols":[],"#,
                r#""authLoginSupported":false,"supportedPermissionModes":["default"],"supportedThinkingModes":[],"settings":[],"#,
                r#""defaultSettings":{"ownerId":"chat","schemaVersion":1,"values":{}},"requiresStrictModelDiscovery":true,"#,
                r#""generation":{"priority":1,"model":"claude-sonnet"},"defaultModel":"shell","models":[{"value":"shell","label":"Shell","isLocal":true}]}"#,
            ]
            .concat()
        );
        let catalog: AgentCatalog =
            serde_json::from_value(json!({ "agents": [described], "apiProviders": [] })).unwrap();
        assert_eq!(catalog.agents.len(), 1);
        assert!(catalog.api_providers.is_empty());
    }
}
