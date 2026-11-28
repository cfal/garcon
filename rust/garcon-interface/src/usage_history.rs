//! Ports `server-agents/interface/src/contracts/usage-history.ts`.

use async_trait::async_trait;
use garcon_contract::usage::{AgentUsageReport, UsageReadRequest};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::resources::ExecutorResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentUsageReadRequest {
    #[serde(flatten)]
    pub request: UsageReadRequest,
    #[serde(skip)]
    pub signal: Option<CancellationToken>,
}

#[async_trait(?Send)]
pub trait AgentUsageHistory {
    /// Reads native history, including sessions Garcon did not start, without mutating it.
    async fn read(&self, request: AgentUsageReadRequest) -> ExecutorResult<AgentUsageReport>;
}
