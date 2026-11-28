//! Ports `server-agents/interface/src/contracts/host.ts`.

use std::rc::Rc;

use async_trait::async_trait;
use garcon_contract::agent_execution::AgentCredentialReference;
use garcon_js::{Number, json::Opaque};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::resources::{AgentResourceScope, ExecutorResult};

pub struct AgentHost {
    pub agent_id: String,
    pub scope: AgentResourceScope,
    pub migrations: Rc<dyn AgentMigrationStore>,
    pub logger: Rc<dyn AgentLogger>,
    pub storage: Rc<dyn AgentScopedStorage>,
    pub environment: Rc<dyn AgentEnvironmentReader>,
    pub api_providers: Rc<dyn AgentApiProviderReader>,
}

pub trait AgentHostFactory {
    fn for_agent(&self, agent_id: &str) -> AgentHost;
}

#[async_trait(?Send)]
pub trait AgentScopedStorage {
    fn root_directory(&self) -> &str;
    async fn directory(&self, namespace: &str) -> ExecutorResult<String>;
    async fn claim_legacy_workspace_directory(
        &self,
        name: &str,
    ) -> ExecutorResult<AgentLegacyDirectoryClaim>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentLegacyDirectoryClaim {
    pub moved: u64,
    pub skipped: u64,
}

pub trait AgentLogger {
    fn debug(&self, message: &str, fields: Option<&IndexMap<String, Opaque>>);
    fn info(&self, message: &str, fields: Option<&IndexMap<String, Opaque>>);
    fn warn(&self, message: &str, fields: Option<&IndexMap<String, Opaque>>);
    fn error(&self, message: &str, fields: Option<&IndexMap<String, Opaque>>);
}

pub trait AgentEnvironmentReader {
    fn get(&self, name: &str) -> Option<String>;
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AgentResolveCredentialRequest {
    pub reference: AgentCredentialReference,
    #[serde(skip)]
    pub signal: CancellationToken,
}

#[async_trait(?Send)]
pub trait AgentApiProviderReader {
    async fn resolve_credential(
        &self,
        request: AgentResolveCredentialRequest,
    ) -> ExecutorResult<Option<AgentResolvedCredential>>;
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentResolvedCredential {
    pub kind: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMigrationCommit {
    pub expected_version: Number,
    pub next_version: Number,
    pub set: IndexMap<String, Opaque>,
    pub delete: Vec<String>,
}

#[async_trait(?Send)]
pub trait AgentMigrationStore {
    async fn get_version(&self) -> ExecutorResult<Number>;
    async fn read(&self, key: &str) -> ExecutorResult<Option<Opaque>>;
    async fn commit(&self, request: AgentMigrationCommit) -> ExecutorResult<()>;
}
