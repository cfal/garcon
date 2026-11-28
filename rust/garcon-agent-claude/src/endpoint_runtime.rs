use garcon_agents_common::execution::resolve_endpoint::ResolvedAgentEndpoint;
use garcon_contract::api_providers::ApiProtocol;
use garcon_interface::errors::AgentIntegrationError;
use indexmap::IndexMap;
use serde::Serialize;

use crate::model_context::resolve_claude_model;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeEndpointRuntime {
    pub env_overrides: IndexMap<String, String>,
}

pub fn build_claude_endpoint_runtime(
    endpoint: &ResolvedAgentEndpoint,
) -> Result<Option<ClaudeEndpointRuntime>, AgentIntegrationError> {
    if endpoint.selection.protocol != ApiProtocol::AnthropicMessages {
        return Ok(None);
    }
    let mut env_overrides = IndexMap::new();
    env_overrides.insert(
        "ANTHROPIC_BASE_URL".into(),
        endpoint.selection.base_url.clone(),
    );
    if let Some(credential) = endpoint
        .credential
        .as_ref()
        .filter(|credential| !credential.is_empty())
    {
        env_overrides.insert("ANTHROPIC_AUTH_TOKEN".into(), credential.clone());
    }
    env_overrides.insert("ANTHROPIC_API_KEY".into(), String::new());
    env_overrides.insert(
        "CLAUDE_CODE_SUBAGENT_MODEL".into(),
        resolve_claude_model(&endpoint.selection.model)?.model,
    );
    env_overrides.insert("CLAUDE_CODE_SUBAGENT_MODEL_FORCE".into(), "1".into());
    Ok(Some(ClaudeEndpointRuntime { env_overrides }))
}

#[cfg(test)]
mod tests {
    use garcon_cases::{CaseError, replay, unknown};
    use garcon_contract::agent_execution::AgentEndpointSelection;
    use serde_json::json;

    use super::*;

    #[test]
    fn recorded_endpoint_environment_matches() {
        replay(
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/endpoint-runtime"),
            |function, args| {
                if function != "buildClaudeEndpointRuntime" {
                    return Err(CaseError::unhandled(function));
                }
                let endpoint = unknown(function, args.first())?;
                let selection = &endpoint["selection"];
                let protocol = if selection["protocol"] == "anthropic-messages" {
                    ApiProtocol::AnthropicMessages
                } else {
                    ApiProtocol::OpenAiCompatible
                };
                let endpoint = ResolvedAgentEndpoint {
                    selection: AgentEndpointSelection {
                        api_provider_id: selection["apiProviderId"]
                            .as_str()
                            .unwrap_or_default()
                            .to_owned(),
                        endpoint_id: selection["endpointId"]
                            .as_str()
                            .unwrap_or_default()
                            .to_owned(),
                        provider_label: String::new(),
                        protocol,
                        base_url: selection["baseUrl"].as_str().unwrap_or_default().to_owned(),
                        model: selection["model"].as_str().unwrap_or_default().to_owned(),
                        is_local: selection["isLocal"] == true,
                        capabilities: None,
                        headers: IndexMap::new(),
                        credential: None,
                    },
                    credential: endpoint["credential"].as_str().map(str::to_owned),
                };
                Ok(match build_claude_endpoint_runtime(&endpoint) {
                    Ok(runtime) => serde_json::to_value(runtime).unwrap(),
                    Err(error) => json!({
                        "$":"error", "name":"AgentIntegrationError", "message":error.message,
                        "properties":{"code":error.code.as_str(),"retryable":error.retryable}
                    }),
                })
            },
        );
    }
}
