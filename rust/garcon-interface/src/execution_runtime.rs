//! Ports `server-agents/interface/src/contracts/execution-runtime.ts`.

use std::rc::Rc;

use async_trait::async_trait;
use garcon_contract::api_providers::{
    ApiProtocol, ApiProviderModelDiscoveryResponse, ModelDiscoveryKind,
};
use garcon_contract::executor_path::ExecutorPath;
use garcon_contract::project_resolution::ProjectResolution;
use garcon_contract::tickets::TicketProjectDefault;
use serde::{Deserialize, Serialize};

use crate::{
    files::ExecutionFilesService,
    git::{ExecutionGhService, ExecutionGitService},
    integration::AgentIntegration,
    resources::{ExecutorCallOptions, ExecutorResult},
    terminals::ExecutionTerminalService,
};

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
    pub project_base_path: ExecutorPath,
    pub integration_ids: Vec<String>,
    pub services: ExecutorServices,
}

#[async_trait(?Send)]
pub trait ExecutionRuntimeApi {
    fn id(&self) -> &str;
    fn availability(&self) -> ExecutorAvailability;
    async fn get_info(&self, options: Option<ExecutorCallOptions>) -> ExecutorResult<ExecutorInfo>;
    async fn get_agent_integration(
        &self,
        agent_id: &str,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Rc<AgentIntegration>>;
    async fn get_project_service(
        &self,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Rc<dyn ExecutionProjectService>>;
    async fn discover_api_provider_models(
        &self,
        request: ApiProviderDiscoveryRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<ApiProviderModelDiscoveryResponse>;
    async fn get_files_service(
        &self,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Rc<dyn ExecutionFilesService>>;
    async fn get_git_service(
        &self,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Rc<dyn ExecutionGitService>>;
    async fn get_gh_service(
        &self,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Rc<dyn ExecutionGhService>>;
    async fn get_terminal_service(
        &self,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Rc<dyn ExecutionTerminalService>>;
    fn on_availability_changed(&self, listener: Rc<dyn Fn(ExecutorAvailability)>) -> Box<dyn Fn()>;
    async fn dispose(&self) -> ExecutorResult<()>;
}
