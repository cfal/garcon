//! Ports `server-agents/interface/src/contracts/cli-updates.ts`.

use async_trait::async_trait;
use garcon_contract::agent_cli_update::AgentCliUpdateStatus;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::resources::ExecutorResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCliUpdateStatusRequest {
    pub refresh: bool,
    #[serde(skip)]
    pub signal: Option<CancellationToken>,
}

#[async_trait(?Send)]
pub trait AgentCliUpdates {
    async fn status(
        &self,
        request: AgentCliUpdateStatusRequest,
    ) -> ExecutorResult<AgentCliUpdateStatus>;
    async fn start_update(&self) -> ExecutorResult<AgentCliUpdateStatus>;
}
