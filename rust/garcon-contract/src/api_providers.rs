//! Ports `common/api-providers.ts`.

use std::sync::LazyLock;

use garcon_js::OptionalNullable;
use indexmap::IndexMap;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agents::AgentModelOption;

/// The protocol an API provider speaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ApiProtocol {
    #[serde(rename = "anthropic-messages")]
    AnthropicMessages,
    #[serde(rename = "openai-compatible")]
    OpenAiCompatible,
}

impl ApiProtocol {
    pub fn as_str(self) -> &'static str {
        match self {
            ApiProtocol::AnthropicMessages => "anthropic-messages",
            ApiProtocol::OpenAiCompatible => "openai-compatible",
        }
    }
}

/// How an API provider lists its models.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ModelDiscoveryKind {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "anthropic-models")]
    AnthropicModels,
    #[serde(rename = "openai-models")]
    OpenAiModels,
    #[serde(rename = "ollama-tags")]
    OllamaTags,
    #[serde(rename = "openrouter-models")]
    OpenRouterModels,
}

/// The templates a new API provider starts from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApiProviderTemplateId {
    AlibabaCloud,
    Fireworks,
    Gemini,
    Ollama,
    Openrouter,
    Together,
    Zai,
    Custom,
}

impl ApiProviderTemplateId {
    pub fn as_str(self) -> &'static str {
        match self {
            ApiProviderTemplateId::AlibabaCloud => "alibaba-cloud",
            ApiProviderTemplateId::Fireworks => "fireworks",
            ApiProviderTemplateId::Gemini => "gemini",
            ApiProviderTemplateId::Ollama => "ollama",
            ApiProviderTemplateId::Openrouter => "openrouter",
            ApiProviderTemplateId::Together => "together",
            ApiProviderTemplateId::Zai => "zai",
            ApiProviderTemplateId::Custom => "custom",
        }
    }
}

pub const API_PROVIDER_TEMPLATE_IDS: &[ApiProviderTemplateId] = &[
    ApiProviderTemplateId::AlibabaCloud,
    ApiProviderTemplateId::Fireworks,
    ApiProviderTemplateId::Gemini,
    ApiProviderTemplateId::Ollama,
    ApiProviderTemplateId::Openrouter,
    ApiProviderTemplateId::Together,
    ApiProviderTemplateId::Zai,
    ApiProviderTemplateId::Custom,
];

/// Which OpenAI APIs an endpoint serves.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiEndpointCapabilities {
    pub chat_completions: bool,
    pub responses: bool,
}

/// What the clients see of an API provider. It holds no credential.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiProviderCatalogEntry {
    pub id: String,
    pub revision: i64,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_id: Option<ApiProviderTemplateId>,
    pub created_at: String,
    pub updated_at: String,
    pub endpoints: Vec<ApiProviderEndpointCatalogEntry>,
}

/// Which API providers each executor may use, and the revision of those
/// assignments.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiProviderAssignments {
    pub revision: i64,
    pub assignments: IndexMap<String, Vec<String>>,
}

/// The API providers and their assignments as the settings page shows them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiProviderManagement {
    pub providers: Vec<ApiProviderCatalogEntry>,
    pub assignments: ApiProviderAssignments,
}

/// What became of an assignment on the executors it was sent to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiProviderAssignmentOutcome {
    pub executor_ids: Vec<String>,
    pub status: ApiProviderAssignmentStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Whether an assignment reached its executors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApiProviderAssignmentStatus {
    Assigned,
    NotAssigned,
    Unknown,
}

/// An API provider as a request to create it returns it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiProviderCreateResult {
    #[serde(flatten)]
    pub entry: ApiProviderCatalogEntry,
    pub assignment: ApiProviderAssignmentOutcome,
}

/// An API provider as a request to change it returns it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiProviderUpdateResult {
    #[serde(flatten)]
    pub entry: ApiProviderCatalogEntry,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assignment: Option<ApiProviderAssignmentOutcome>,
}

/// A model as a request names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiProviderEndpointInputModel {
    pub value: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supports_images: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_local: Option<bool>,
}

/// An endpoint as a request to create or change a provider names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiProviderEndpointInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub protocol: ApiProtocol,
    pub base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clear_api_key: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<OpenAiEndpointCapabilities>,
    pub default_model: String,
    pub models: Vec<ApiProviderEndpointInputModel>,
    pub supports_images: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_discovery: Option<ModelDiscoveryKind>,
}

/// A request to create or change an API provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiProviderInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executor_ids: Option<Vec<String>>,
    pub template_id: ApiProviderTemplateId,
    pub label: String,
    pub endpoint: ApiProviderEndpointInput,
}

/// An endpoint as the clients see it. It holds no credential, only whether one
/// is set and, when the store keeps it, a label for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiProviderEndpointCatalogEntry {
    pub id: String,
    pub protocol: ApiProtocol,
    pub base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<OpenAiEndpointCapabilities>,
    pub default_model: String,
    pub models: Vec<AgentModelOption>,
    pub supports_images: bool,
    pub has_api_key: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_discovery: Option<ModelDiscoveryKind>,
}

/// A request to list the models an endpoint serves.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiProviderModelDiscoveryRequest {
    pub protocol: ApiProtocol,
    pub base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "OptionalNullable::is_absent")]
    pub api_provider_id: OptionalNullable<String>,
    #[serde(default, skip_serializing_if = "OptionalNullable::is_absent")]
    pub endpoint_id: OptionalNullable<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_discovery: Option<ModelDiscoveryKind>,
}

/// What listing the models of an endpoint gave.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiProviderModelDiscoveryResponse {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<AgentModelOption>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

static SAFE_ID_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9_-]{1,63}$").expect("SAFE_ID_RE compiles"));

/// Whether `value` is the ID of an API provider: two to sixty-four lower-case
/// letters, digits, underscores, or hyphens, the first of them a letter.
pub fn is_api_provider_id(value: &Value) -> bool {
    value.as_str().is_some_and(|id| SAFE_ID_RE.is_match(id))
}

/// Whether `value` names a template a new API provider starts from.
pub fn is_api_provider_template_id(value: &Value) -> Option<ApiProviderTemplateId> {
    let text = value.as_str()?;
    API_PROVIDER_TEMPLATE_IDS
        .iter()
        .copied()
        .find(|template| template.as_str() == text)
}

/// The name the settings page gives the providers that speak `protocol`.
pub fn label_for_protocol(protocol: &str) -> &'static str {
    if protocol == "anthropic-messages" {
        "Anthropic-compatible"
    } else {
        "OpenAI-compatible"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_an_api_provider_id() {
        for valid in [
            "ab",
            "a-",
            "a_",
            "z9",
            "a-b_c9",
            "custom",
            "alibaba-cloud",
            "x0123456789",
        ] {
            assert!(is_api_provider_id(&json!(valid)), "{valid}");
        }
        // Sixty-four characters is the longest ID.
        let longest = format!("a{}", "b".repeat(63));
        assert!(is_api_provider_id(&json!(longest)));
        let too_long = format!("a{}", "b".repeat(64));
        assert!(!is_api_provider_id(&json!(too_long)));
        for invalid in [
            json!(""),
            json!("a"),
            json!("A"),
            json!("1ab"),
            json!("-ab"),
            json!("_ab"),
            json!("aB"),
            json!("a.b"),
            json!("a b"),
            json!("ab "),
            json!(" ab"),
            json!("a/b"),
            json!("é"),
            json!("\u{0131}b"),
            json!("\u{212A}"),
            json!("ab\n"),
            json!(5),
            json!(null),
            json!(true),
            json!([]),
            json!({}),
        ] {
            assert!(!is_api_provider_id(&invalid), "{invalid}");
        }
    }

    #[test]
    fn reads_a_template_id() {
        let names: Vec<&str> = API_PROVIDER_TEMPLATE_IDS
            .iter()
            .map(|template| template.as_str())
            .collect();
        assert_eq!(
            names,
            [
                "alibaba-cloud",
                "fireworks",
                "gemini",
                "ollama",
                "openrouter",
                "together",
                "zai",
                "custom",
            ]
        );
        for template in API_PROVIDER_TEMPLATE_IDS {
            assert_eq!(
                is_api_provider_template_id(&json!(template.as_str())),
                Some(*template)
            );
            assert_eq!(
                serde_json::to_value(*template).unwrap(),
                json!(template.as_str())
            );
        }
        for other in [
            json!("Custom"),
            json!("CUSTOM"),
            json!(" custom"),
            json!("custom "),
            json!(""),
            json!("azure"),
            json!(null),
            json!(5),
            json!([]),
        ] {
            assert_eq!(is_api_provider_template_id(&other), None, "{other}");
        }
    }

    #[test]
    fn writes_each_model_discovery_kind_under_its_name() {
        for (kind, name) in [
            (ModelDiscoveryKind::None, "none"),
            (ModelDiscoveryKind::AnthropicModels, "anthropic-models"),
            (ModelDiscoveryKind::OpenAiModels, "openai-models"),
            (ModelDiscoveryKind::OllamaTags, "ollama-tags"),
            (ModelDiscoveryKind::OpenRouterModels, "openrouter-models"),
        ] {
            assert_eq!(serde_json::to_value(kind).unwrap(), json!(name));
            assert_eq!(
                serde_json::from_value::<ModelDiscoveryKind>(json!(name)).unwrap(),
                kind
            );
        }
        assert_eq!(
            ModelDiscoveryKind::None,
            serde_json::from_value(json!("none")).unwrap()
        );
        for (status, name) in [
            (ApiProviderAssignmentStatus::Assigned, "assigned"),
            (ApiProviderAssignmentStatus::NotAssigned, "not-assigned"),
            (ApiProviderAssignmentStatus::Unknown, "unknown"),
        ] {
            assert_eq!(serde_json::to_value(status).unwrap(), json!(name));
        }
    }

    #[test]
    fn names_the_providers_of_a_protocol() {
        assert_eq!(
            label_for_protocol("anthropic-messages"),
            "Anthropic-compatible"
        );
        // Any other protocol, as the original reads it.
        assert_eq!(label_for_protocol("openai-compatible"), "OpenAI-compatible");
        assert_eq!(label_for_protocol(""), "OpenAI-compatible");
        assert_eq!(
            ApiProtocol::AnthropicMessages.as_str(),
            "anthropic-messages"
        );
        assert_eq!(ApiProtocol::OpenAiCompatible.as_str(), "openai-compatible");
    }

    #[test]
    fn reads_and_writes_providers_in_the_original_shape() {
        let management = json!({
            "providers": [{
                "id": "custom",
                "revision": 1,
                "label": "Custom",
                "templateId": "custom",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:00.000Z",
                "endpoints": [{
                    "id": "main",
                    "protocol": "openai-compatible",
                    "baseUrl": "https://example.test/v1",
                    "capabilities": { "chatCompletions": true, "responses": false },
                    "defaultModel": "m",
                    "models": [{ "value": "m", "label": "M", "supportsImages": true, "isLocal": false }],
                    "supportsImages": true,
                    "hasApiKey": false,
                    "apiKeyLabel": "",
                    "modelDiscovery": "openai-models",
                }],
            }],
            "assignments": { "revision": 0, "assignments": { "local": ["custom"] } },
        });
        let parsed: ApiProviderManagement =
            serde_json::from_value(management.clone()).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(parsed.providers[0].revision, 1);
        assert_eq!(parsed.assignments.assignments["local"], ["custom"]);
        assert_eq!(
            serde_json::to_string(&parsed).unwrap(),
            serde_json::to_string(&management).unwrap()
        );

        let created = json!({
            "id": "custom",
            "revision": 1,
            "label": "Custom",
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z",
            "endpoints": [],
            "assignment": { "executorIds": ["local"], "status": "not-assigned", "error": "offline" },
        });
        let parsed: ApiProviderCreateResult = serde_json::from_value(created.clone()).unwrap();
        assert_eq!(
            parsed.assignment.status,
            ApiProviderAssignmentStatus::NotAssigned
        );
        assert_eq!(
            serde_json::to_string(&parsed).unwrap(),
            serde_json::to_string(&created).unwrap()
        );

        // An optional property stays absent when it is left out.
        let updated: ApiProviderUpdateResult = serde_json::from_value(json!({
            "id": "custom", "revision": 2, "label": "Custom",
            "createdAt": "c", "updatedAt": "u", "endpoints": [],
        }))
        .unwrap();
        assert_eq!(updated.assignment, None);
        assert_eq!(
            serde_json::to_string(&updated).unwrap(),
            r#"{"id":"custom","revision":2,"label":"Custom","createdAt":"c","updatedAt":"u","endpoints":[]}"#
        );
        let response: ApiProviderModelDiscoveryResponse =
            serde_json::from_value(json!({ "success": false })).unwrap();
        assert_eq!(
            serde_json::to_string(&response).unwrap(),
            r#"{"success":false}"#
        );
    }

    #[test]
    fn keeps_an_absent_and_a_null_lookup_id_apart() {
        let absent: ApiProviderModelDiscoveryRequest = serde_json::from_value(json!({
            "protocol": "anthropic-messages", "baseUrl": "https://example.test",
        }))
        .unwrap();
        assert_eq!(absent.api_provider_id, OptionalNullable::ABSENT);
        assert_eq!(
            serde_json::to_string(&absent).unwrap(),
            r#"{"protocol":"anthropic-messages","baseUrl":"https://example.test"}"#
        );
        let null: ApiProviderModelDiscoveryRequest = serde_json::from_value(json!({
            "protocol": "anthropic-messages", "baseUrl": "https://example.test", "apiProviderId": null,
        }))
        .unwrap();
        assert_eq!(null.api_provider_id, OptionalNullable::NULL);
        assert_eq!(
            serde_json::to_string(&null).unwrap(),
            r#"{"protocol":"anthropic-messages","baseUrl":"https://example.test","apiProviderId":null}"#
        );
        // The protocol is one of the two the original names.
        assert!(
            serde_json::from_value::<ApiProviderModelDiscoveryRequest>(json!({
                "protocol": "openai", "baseUrl": "b",
            }))
            .is_err()
        );
    }
}
