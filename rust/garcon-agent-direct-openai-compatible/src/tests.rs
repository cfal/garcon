use garcon_agents_common::direct::conformance_host::conformance_host;
use garcon_interface::testing::{
    AgentIntegrationConformanceOptions, run_agent_integration_conformance,
};
use tokio::task::LocalSet;

use super::*;

#[tokio::test]
async fn chat_completions_conforms_to_the_agent_integration_contract() {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let class = DirectOpenAiCompatibleIntegration;
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
            assert!(integration.native_history_import.is_some());
            assert!(integration.legacy_history_import.is_none());
            assert!(integration.native_sessions.is_some());
            assert!(integration.forking.is_none());
        })
        .await;
}
