//! Ports `server-agents/interface/src/contracts/execution-runtime.ts`.

use async_trait::async_trait;
use garcon_contract::api_providers::{ApiProtocol, ModelDiscoveryKind};
use garcon_contract::executor_path::ExecutorPath;
use garcon_contract::project_resolution::ProjectResolution;
use garcon_contract::tickets::TicketProjectDefault;
use serde::{Deserialize, Serialize};

use crate::resources::{ExecutorCallOptions, ExecutorResult};

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiProviderDiscoveryRequest {
    pub protocol: ApiProtocol,
    pub base_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    pub model_discovery: ModelDiscoveryKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketProjectDefaultRequest {
    pub project_path: ExecutorPath,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionProjectInspectRequest {
    pub project_path: ExecutorPath,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_git_repository: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionProjectInspectResponse {
    pub resolution: ProjectResolution,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_git_repository: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveFileMentionsRequest {
    pub project_path: ExecutorPath,
    pub command: String,
}

#[async_trait(?Send)]
pub trait ExecutionProjectService {
    async fn ticket_project_default(
        &self,
        request: TicketProjectDefaultRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<TicketProjectDefault>;
    async fn inspect(
        &self,
        request: ExecutionProjectInspectRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<ExecutionProjectInspectResponse>;
    async fn resolve_file_mentions(
        &self,
        request: ResolveFileMentionsRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<String>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExecutorAvailability {
    Ready,
    Reconnecting,
    Offline,
    Disposed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorServices {
    pub files: bool,
    pub git: bool,
    pub gh: bool,
    pub terminals: bool,
    pub directory_creation: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorInfo {
    pub executor_id: String,
    pub instance_id: String,
    pub integration_ids: Vec<String>,
    pub project_base_path: ExecutorPath,
    pub services: ExecutorServices,
}
