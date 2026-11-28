//! Ports `server-agents/direct-openai-compatible/src/index.ts`.

use garcon_agents_common::direct::{
    integration::{DirectIntegrationOptions, create_direct_integration},
    router::create_direct_open_ai_chat_runtime,
};
use garcon_contract::{
    agent_integration::AgentDescriptor,
    agents::{
        DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_ID as ID,
        DIRECT_OPENAI_CHAT_COMPLETIONS_COMPATIBLE_AGENT_LABEL as LABEL,
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

pub struct DirectOpenAiCompatibleIntegration;

impl AgentIntegrationClass for DirectOpenAiCompatibleIntegration {
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
                generation_priority: Number(50.0),
                endpoint_protocol: ApiProtocol::OpenAiCompatible,
                incompatible_endpoint_message: "OpenAI Compatible requires an OpenAI-compatible endpoint",
                missing_endpoint_message: "OpenAI Compatible requires an API provider endpoint",
            },
            create_direct_open_ai_chat_runtime,
        )
    }
}

#[cfg(test)]
mod tests;
