//! Ports `common/generation-test-contracts.ts`.

use garcon_js::Number;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::chat_modes::{DEFAULT_THINKING_MODE, ThinkingMode, normalize_thinking_mode};
use crate::executors::{ExecutorId, effective_executor_id};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GenerationTestTarget {
    ChatTitle,
    AgentSwitchCompaction,
    CommitMessage,
    PromptRefinement,
}

pub const GENERATION_TEST_TARGETS: &[GenerationTestTarget] = &[
    GenerationTestTarget::ChatTitle,
    GenerationTestTarget::AgentSwitchCompaction,
    GenerationTestTarget::CommitMessage,
    GenerationTestTarget::PromptRefinement,
];

pub fn is_generation_test_target(value: &Value) -> Option<GenerationTestTarget> {
    match value.as_str()? {
        "chatTitle" => Some(GenerationTestTarget::ChatTitle),
        "agentSwitchCompaction" => Some(GenerationTestTarget::AgentSwitchCompaction),
        "commitMessage" => Some(GenerationTestTarget::CommitMessage),
        "promptRefinement" => Some(GenerationTestTarget::PromptRefinement),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationModelTestRequest {
    pub target: GenerationTestTarget,
    pub configuration_key: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationModelTestResponse {
    pub success: bool,
    pub target: GenerationTestTarget,
    pub duration_ms: Number,
}

pub fn generation_model_test_configuration_key(config: &Map<String, Value>) -> String {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Key<'a> {
        executor_id: ExecutorId,
        agent_id: &'a str,
        model: &'a str,
        api_provider_id: Option<&'a str>,
        model_endpoint_id: Option<&'a str>,
        model_protocol: Option<&'a str>,
        thinking_mode: ThinkingMode,
    }
    let field = |name: &str| config.get(name).and_then(Value::as_str);
    let key = Key {
        executor_id: effective_executor_id(field("executorId")),
        agent_id: field("agentId").unwrap_or_default(),
        model: field("model").unwrap_or_default(),
        api_provider_id: field("apiProviderId"),
        model_endpoint_id: field("modelEndpointId"),
        model_protocol: field("modelProtocol"),
        thinking_mode: normalize_thinking_mode(
            config.get("thinkingMode").unwrap_or(&Value::Null),
            DEFAULT_THINKING_MODE,
        ),
    };
    // INFALLIBLE: this key consists only of strings, null, and a string enum.
    serde_json::to_string(&key).expect("serialize generation test key")
}
