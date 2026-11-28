use garcon_agent_pi::PiAgentIntegration;
use garcon_agents_common::direct::conformance_host::conformance_host;
use garcon_interface::integration::AgentIntegrationClass;
use garcon_interface::testing::{
    AgentIntegrationConformanceOptions, run_agent_integration_conformance,
};
use tokio::task::LocalSet;

#[tokio::test]
async fn pi_conforms_to_the_agent_integration_contract() {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let class = PiAgentIntegration;
            let integration = class.create(conformance_host("pi", root.path()).unwrap());
            run_agent_integration_conformance(AgentIntegrationConformanceOptions {
                integration_id: class.integration_id(),
                api_version: class.api_version(),
                integration: &integration,
            })
            .await
            .unwrap();
            assert!(integration.native_history_import.is_some());
            assert!(integration.legacy_history_import.is_some());
            assert!(integration.single_query.is_some());
            assert!(integration.steering.is_some());
            assert!(integration.forking.is_none());
        })
        .await;
}
