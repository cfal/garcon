//! Ports `server-agents/direct-openai-responses-compatible/src/index.ts`.

use garcon_agents_common::direct::{
    integration::{DirectIntegrationOptions, create_direct_integration},
    router::create_direct_open_ai_responses_runtime,
};
use garcon_contract::{
    agent_integration::AgentDescriptor,
    agents::{
        DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_ID as ID,
        DIRECT_OPENAI_RESPONSES_COMPATIBLE_AGENT_LABEL as LABEL,
    },
    api_providers::ApiProtocol,
    attachments::TEXT_FILE_ATTACHMENT_MIME_TYPES,
    chat_modes::{PERMISSION_MODE_VALUES, PermissionMode, THINKING_MODE_VALUES},
};
use garcon_interface::{
    host::AgentHost,
    integration::{AGENT_INTEGRATION_API_VERSION, AgentIntegration, AgentIntegrationClass},
};
use garcon_js::Number;

pub struct DirectOpenAiResponsesCompatibleIntegration;

impl AgentIntegrationClass for DirectOpenAiResponsesCompatibleIntegration {
    fn integration_id(&self) -> &str {
        ID
    }

    fn api_version(&self) -> u64 {
        AGENT_INTEGRATION_API_VERSION
    }

    fn create(&self, host: AgentHost) -> AgentIntegration {
        create_direct_integration(
            host,
            DirectIntegrationOptions {
                descriptor: AgentDescriptor {
                    id: ID.into(),
                    label: LABEL.into(),
                    icon: None,
                    supported_permission_modes: PERMISSION_MODE_VALUES
                        .iter()
                        .copied()
                        .filter(|mode| *mode != PermissionMode::Plan)
                        .collect(),
                    supported_thinking_modes: THINKING_MODE_VALUES.to_vec(),
                    supports_images: true,
                    supports_project_path_update: true,
                    requires_native_path_for_project_path_update: false,
                    supported_endpoint_protocols: vec![ApiProtocol::OpenAiCompatible],
                    configuration: Vec::new(),
                },
                file_mime_types: TEXT_FILE_ATTACHMENT_MIME_TYPES
                    .iter()
                    .copied()
                    .map(str::to_owned)
                    .collect(),
                generation_priority: Number(40.0),
                endpoint_protocol: ApiProtocol::OpenAiCompatible,
                incompatible_endpoint_message: "OpenAI Responses Compatible requires an OpenAI-compatible endpoint",
                missing_endpoint_message: "OpenAI Responses Compatible requires an API provider endpoint",
            },
            create_direct_open_ai_responses_runtime,
        )
    }
}

#[cfg(test)]
mod tests {
    use garcon_agents_common::direct::conformance_host::conformance_host;
    use garcon_interface::{
        services::AgentCatalogRequest,
        testing::{AgentIntegrationConformanceOptions, run_agent_integration_conformance},
    };

    use super::*;

    #[tokio::test]
    async fn responses_conforms_and_exposes_its_generation_priority() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let class = DirectOpenAiResponsesCompatibleIntegration;
                let root = tempfile::tempdir().unwrap();
                let integration = class.create(conformance_host(ID, root.path()).unwrap());
                run_agent_integration_conformance(AgentIntegrationConformanceOptions {
                    integration_id: class.integration_id(),
                    api_version: class.api_version(),
                    integration: &integration,
                })
                .await
                .unwrap();
                assert_eq!(
                    integration.descriptor.supported_endpoint_protocols,
                    [ApiProtocol::OpenAiCompatible]
                );
                let catalog = integration
                    .catalog
                    .snapshot(AgentCatalogRequest {
                        strict: false,
                        require_native_discovery: None,
                        signal: Default::default(),
                        timeout_ms: None,
                        dispatch_deadline: None,
                    })
                    .await
                    .unwrap();
                assert_eq!(catalog.generation.unwrap().priority, Number(40.0));
            })
            .await;
    }
}
