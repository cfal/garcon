//! Ports `server-agents/interface/src/contracts/execution.ts`.

use async_trait::async_trait;
use garcon_contract::{
    agent_execution::AgentEndpointSelection,
    agent_integration::AgentSettingsEnvelope,
    chat_modes::{PermissionMode, ThinkingMode},
};
use garcon_js::OptionalNullable;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::{
    resources::{AgentProjectPathPreparation, ExecutorCallOptions, ExecutorResult},
    transcript::{AgentChatReference, AgentNativeSessionRef},
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionConfiguration {
    pub model: String,
    pub permission_mode: PermissionMode,
    pub thinking_mode: ThinkingMode,
    pub settings: AgentSettingsEnvelope,
    pub endpoint: Option<AgentEndpointSelection>,
}

#[derive(Debug, Clone)]
pub struct AgentProjectPathUpdateRequest {
    pub chat: AgentChatReference,
    pub next_project_path: String,
    pub signal: CancellationToken,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPrepareProjectPathUpdateRequest {
    pub chat: AgentChatReference,
    pub next_project_path: String,
}

#[async_trait(?Send)]
pub trait AgentProjectPathUpdatePreparation {
    fn native_session(&self) -> OptionalNullable<&AgentNativeSessionRef>;
    async fn commit(&self) -> ExecutorResult<()>;
    async fn rollback(&self) -> ExecutorResult<()>;
}

#[async_trait(?Send)]
pub trait AgentExecutionAdmission {
    fn signal(&self) -> &CancellationToken;
    async fn mark_started(&self) -> ExecutorResult<()>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunningSession {
    pub agent_session_id: String,
    pub status: Option<String>,
    pub started_at: Option<String>,
}

#[async_trait(?Send)]
pub trait AgentConfigurationValidation {
    async fn validate(
        &self,
        configuration: AgentSessionConfiguration,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()>;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionConfigurationUpdate {
    #[serde(flatten)]
    pub configuration: AgentSessionConfiguration,
    pub permission_mode_explicit: bool,
}

#[async_trait(?Send)]
pub trait AgentSessionConfigurationUpdates {
    async fn apply(
        &self,
        agent_session_id: &str,
        configuration: AgentSessionConfigurationUpdate,
        previous_configuration: AgentSessionConfiguration,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()>;
}

#[async_trait(?Send)]
pub trait AgentProjectPathUpdates {
    async fn prepare(
        &self,
        request: AgentPrepareProjectPathUpdateRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Option<AgentPreparedProjectPathUpdate>>;
    async fn commit(
        &self,
        preparation: AgentProjectPathPreparation,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()>;
    async fn rollback(
        &self,
        preparation: AgentProjectPathPreparation,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()>;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPreparedProjectPathUpdate {
    pub preparation: AgentProjectPathPreparation,
    #[serde(
        default = "absent_native_session",
        skip_serializing_if = "OptionalNullable::is_absent"
    )]
    pub native_session: OptionalNullable<AgentNativeSessionRef>,
}

fn absent_native_session() -> OptionalNullable<AgentNativeSessionRef> {
    OptionalNullable::ABSENT
}
