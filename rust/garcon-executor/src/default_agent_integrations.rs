//! The worker's provider roster. Ports `server/runtime/agents/default-agent-integrations.ts`.

use garcon_agent_direct_openai_compatible::DirectOpenAiCompatibleIntegration;
use garcon_interface::integration::AgentIntegrationClass;

pub(crate) fn default_agent_integrations() -> [&'static dyn AgentIntegrationClass; 1] {
    [&DirectOpenAiCompatibleIntegration]
}

#[cfg(test)]
mod tests {
    use std::rc::Rc;

    use garcon_interface::testing::{
        AgentIntegrationConformanceOptions, run_agent_integration_conformance,
    };
    use garcon_link::rpc_protocol::{IntegrationManifest, NULLABLE_AGENT_FACETS};
    use garcon_runtime::agents::integration_host::{
        IntegrationHostFactory, IntegrationHostFactoryOptions,
    };
    use garcon_runtime::agents::integration_registry::IntegrationRegistry;

    use super::*;

    #[tokio::test]
    async fn registered_integrations_match_the_manifest_and_conform() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let root = tempfile::tempdir().unwrap();
                let host = IntegrationHostFactory::new(IntegrationHostFactoryOptions {
                    workspace_dir: root.path().to_str().unwrap().into(),
                    executor_id: Some("local".into()),
                    instance_id: Some("synthetic-executor".into()),
                    resolve_credential: Rc::new(|_| {
                        Box::pin(async { Err("unexpected credential resolution".into()) })
                    }),
                    read_environment: Some(Rc::new(|_| None)),
                    logger_factory: None,
                });
                let classes = default_agent_integrations();
                let registry = IntegrationRegistry::from_classes(&classes, &host).unwrap();
                assert_eq!(registry.list().len(), classes.len());
                for class in classes {
                    let integration = registry.require(class.integration_id()).unwrap();
                    let manifest = IntegrationManifest::from_integration(&integration).unwrap();
                    assert_eq!(manifest.descriptor.id, class.integration_id());
                    assert_eq!(manifest.scope.integration_id, class.integration_id());
                    assert_eq!(
                        manifest
                            .capabilities
                            .keys()
                            .map(String::as_str)
                            .collect::<Vec<_>>(),
                        NULLABLE_AGENT_FACETS
                    );
                    run_agent_integration_conformance(AgentIntegrationConformanceOptions {
                        integration_id: class.integration_id(),
                        api_version: class.api_version(),
                        integration: integration.as_ref(),
                    })
                    .await
                    .unwrap();
                }
            })
            .await;
    }
}
