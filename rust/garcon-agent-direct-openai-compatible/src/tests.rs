use garcon_interface::{
    host::{
        AgentEnvironmentReader, AgentLegacyDirectoryClaim, AgentLogger, AgentMigrationCommit,
        AgentMigrationStore, AgentResolveCredentialRequest, AgentResolvedCredential,
        AgentScopedStorage,
    },
    resources::AgentResourceScope,
    testing::{AgentIntegrationConformanceOptions, run_agent_integration_conformance},
};
use garcon_js::json::Opaque;
use indexmap::IndexMap;
use tokio::task::LocalSet;

use super::*;

struct TestHost(String);

impl AgentLogger for TestHost {
    fn debug(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn info(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn warn(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn error(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
}

impl AgentEnvironmentReader for TestHost {
    fn get(&self, _: &str) -> ExecutorResult<Option<String>> {
        Ok(None)
    }
}

#[async_trait(?Send)]
impl AgentScopedStorage for TestHost {
    fn root_directory(&self) -> &str {
        &self.0
    }
    async fn directory(&self, name: &str) -> ExecutorResult<String> {
        let path = std::path::Path::new(&self.0).join(name);
        tokio::fs::create_dir_all(&path).await?;
        Ok(path.to_str().unwrap().to_owned())
    }
    async fn claim_legacy_workspace_directory(
        &self,
        _: &str,
    ) -> ExecutorResult<AgentLegacyDirectoryClaim> {
        Err("Direct has no legacy directory claim".into())
    }
}

#[async_trait(?Send)]
impl AgentMigrationStore for TestHost {
    async fn get_version(&self) -> ExecutorResult<Number> {
        Ok(Number(0.0))
    }
    async fn read(&self, _: &str) -> ExecutorResult<Option<Opaque>> {
        Ok(None)
    }
    async fn commit(&self, _: AgentMigrationCommit) -> ExecutorResult<()> {
        Err("Direct has no migration commit".into())
    }
}

#[async_trait(?Send)]
impl AgentApiProviderReader for TestHost {
    async fn resolve_credential(
        &self,
        _: AgentResolveCredentialRequest,
    ) -> ExecutorResult<Option<AgentResolvedCredential>> {
        Err("unexpected credential lookup".into())
    }
}

fn host(root: &std::path::Path) -> AgentHost {
    let test = Rc::new(TestHost(root.to_str().unwrap().into()));
    AgentHost {
        agent_id: ID.into(),
        scope: AgentResourceScope {
            executor_id: "local".into(),
            instance_id: "synthetic-instance".into(),
            integration_id: ID.into(),
        },
        migrations: test.clone(),
        logger: test.clone(),
        storage: test.clone(),
        environment: test.clone(),
        api_providers: test,
    }
}

#[tokio::test]
async fn chat_completions_conforms_to_the_agent_integration_contract() {
    LocalSet::new()
        .run_until(async {
            let root = tempfile::tempdir().unwrap();
            let class = DirectOpenAiCompatibleIntegration;
            let integration = class.create(host(root.path()));
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
