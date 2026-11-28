//! Ports `server-agents/interface/src/contracts/native-fork.ts`.

use async_trait::async_trait;
use garcon_contract::{
    agent_execution::AgentEndpointSelection,
    agent_integration::AgentSettingsEnvelope,
    chat_modes::{PermissionMode, ThinkingMode},
};
use garcon_js::json::Opaque;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::{
    producer::{AgentEstablishedSession, deserialize_provider_meta},
    resources::{AgentInstanceCallOptions, ExecutorResult},
    transcript::AgentChatReference,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentNativeForkRequest {
    pub chat_id: String,
    pub project_path: String,
    pub model: String,
    pub permission_mode: PermissionMode,
    pub thinking_mode: ThinkingMode,
    pub settings: AgentSettingsEnvelope,
    pub endpoint: Option<AgentEndpointSelection>,
    #[serde(skip)]
    pub signal: CancellationToken,
    pub source: AgentChatReference,
    #[serde(deserialize_with = "deserialize_provider_meta")]
    pub provider_meta: Option<Opaque>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AgentNativeForkOutcome {
    Materialized { session: AgentEstablishedSession },
    Unmaterialized,
}

#[async_trait(?Send)]
pub trait AgentNativeFork {
    async fn fork(
        &self,
        request: AgentNativeForkRequest,
        options: Option<AgentInstanceCallOptions>,
    ) -> ExecutorResult<AgentNativeForkOutcome>;
    async fn discard(
        &self,
        session: AgentEstablishedSession,
        signal: CancellationToken,
        options: Option<AgentInstanceCallOptions>,
    ) -> ExecutorResult<()>;
}
