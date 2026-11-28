//! Ports `server-agents/direct-anthropic-compatible/src/index.ts`.

use garcon_agents_common::direct::{
    integration::{DirectIntegrationOptions, create_direct_integration},
    router::create_direct_anthropic_runtime,
};
use garcon_contract::{
    agent_integration::AgentDescriptor,
    agents::{
        DIRECT_ANTHROPIC_COMPATIBLE_AGENT_ID as ID,
        DIRECT_ANTHROPIC_COMPATIBLE_AGENT_LABEL as LABEL,
    },
    api_providers::ApiProtocol,
    attachments::{DOCUMENT_FILE_ATTACHMENT_MIME_TYPES, TEXT_FILE_ATTACHMENT_MIME_TYPES},
    chat_modes::{PERMISSION_MODE_VALUES, PermissionMode, THINKING_MODE_VALUES},
};
use garcon_interface::{
    host::AgentHost,
    integration::{AGENT_INTEGRATION_API_VERSION, AgentIntegration, AgentIntegrationClass},
};
use garcon_js::Number;

pub struct DirectAnthropicCompatibleIntegration;

impl AgentIntegrationClass for DirectAnthropicCompatibleIntegration {
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
                    supported_endpoint_protocols: vec![ApiProtocol::AnthropicMessages],
                    configuration: Vec::new(),
                },
                file_mime_types: TEXT_FILE_ATTACHMENT_MIME_TYPES
                    .iter()
                    .chain(DOCUMENT_FILE_ATTACHMENT_MIME_TYPES)
                    .copied()
                    .map(str::to_owned)
                    .collect(),
                generation_priority: Number(20.0),
                endpoint_protocol: ApiProtocol::AnthropicMessages,
                incompatible_endpoint_message: "Anthropic Compatible requires an Anthropic Messages endpoint",
                missing_endpoint_message: "Anthropic Compatible requires an API provider endpoint",
            },
            create_direct_anthropic_runtime,
        )
    }
}

#[cfg(test)]
mod tests {
    use garcon_agents_common::direct::conformance_host::conformance_host;
    use garcon_contract::attachments::FileAttachmentMimeTypes;
    use garcon_interface::{
        services::AgentCatalogRequest,
        testing::{AgentIntegrationConformanceOptions, run_agent_integration_conformance},
    };

    use super::*;

    #[tokio::test]
    async fn messages_conforms_and_adds_pdf_attachments() {
        tokio::task::LocalSet::new().run_until(async {
            let class = DirectAnthropicCompatibleIntegration;
            let root = tempfile::tempdir().unwrap();
            let integration = class.create(conformance_host(ID, root.path()).unwrap());
            run_agent_integration_conformance(AgentIntegrationConformanceOptions {
                integration_id: class.integration_id(), api_version: class.api_version(), integration: &integration,
            }).await.unwrap();
            assert_eq!(integration.descriptor.supported_endpoint_protocols, [ApiProtocol::AnthropicMessages]);
            let attachment = integration.attachments.as_ref().unwrap();
            assert!(matches!(&attachment.file_mime_types, FileAttachmentMimeTypes::Listed(types) if types.last().is_some_and(|kind| kind == "application/pdf")));
            let catalog = integration.catalog.snapshot(AgentCatalogRequest {
                strict: false, require_native_discovery: None, signal: Default::default(), timeout_ms: None, dispatch_deadline: None,
            }).await.unwrap();
            assert_eq!(catalog.generation.unwrap().priority, Number(20.0));
        }).await;
    }
}
