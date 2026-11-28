//! An isolated host for the Direct crates' integration-conformance tests.

use std::{path::Path, rc::Rc};

use async_trait::async_trait;
use garcon_interface::{
    host::{
        AgentApiProviderReader, AgentEnvironmentReader, AgentHost, AgentLegacyDirectoryClaim,
        AgentLogger, AgentMigrationCommit, AgentMigrationStore, AgentResolveCredentialRequest,
        AgentResolvedCredential, AgentScopedStorage,
    },
    resources::{AgentResourceScope, ExecutorResult},
};
use garcon_js::{Number, json::Opaque};
use indexmap::IndexMap;

struct Host(String);

impl AgentLogger for Host {
    fn debug(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn info(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn warn(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn error(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
}

impl AgentEnvironmentReader for Host {
    fn get(&self, _: &str) -> ExecutorResult<Option<String>> {
        Ok(None)
    }
}

#[async_trait(?Send)]
impl AgentScopedStorage for Host {
    fn root_directory(&self) -> &str {
        &self.0
    }
    async fn directory(&self, name: &str) -> ExecutorResult<String> {
        let path = Path::new(&self.0).join(name);
        tokio::fs::create_dir_all(&path).await?;
        path.into_os_string()
            .into_string()
            .map_err(|_| "Test storage path is not Unicode".into())
    }
    async fn claim_legacy_workspace_directory(
        &self,
        _: &str,
    ) -> ExecutorResult<AgentLegacyDirectoryClaim> {
        Err("Direct has no legacy directory claim".into())
    }
}

#[async_trait(?Send)]
impl AgentMigrationStore for Host {
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
impl AgentApiProviderReader for Host {
    async fn resolve_credential(
        &self,
        _: AgentResolveCredentialRequest,
    ) -> ExecutorResult<Option<AgentResolvedCredential>> {
        Err("unexpected credential lookup".into())
    }
}

pub fn conformance_host(agent_id: &str, root: &Path) -> ExecutorResult<AgentHost> {
    let test = Rc::new(Host(
        root.to_str().ok_or("Test root is not Unicode")?.into(),
    ));
    Ok(AgentHost {
        agent_id: agent_id.into(),
        scope: AgentResourceScope {
            executor_id: "local".into(),
            instance_id: "synthetic-instance".into(),
            integration_id: agent_id.into(),
        },
        migrations: test.clone(),
        logger: test.clone(),
        storage: test.clone(),
        environment: test.clone(),
        api_providers: test,
    })
}
