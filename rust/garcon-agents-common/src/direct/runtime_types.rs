//! Ports `server-agents/common/src/direct/runtime-types.ts`.

use std::rc::Rc;

use garcon_contract::agent_execution::AgentAttachment;
use garcon_contract::chat_modes::{PermissionMode, ThinkingMode};
use garcon_interface::execution::AgentExecutionAdmission;
use garcon_interface::resources::ExecutorResult;
use garcon_interface::transcript::AgentNativeSessionRef;
use serde::Serialize;

use crate::execution::{
    admission, resolve_endpoint::ResolvedAgentEndpoint, runtime_events::AgentRuntimeOperation,
};

pub type DirectEndpointRuntime = ResolvedAgentEndpoint;

#[derive(Serialize, Clone, Copy, Debug, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DirectMessageRole {
    User,
    Assistant,
}

pub struct DirectExecutionRequest {
    pub chat_id: String,
    pub project_path: String,
    pub model: String,
    pub permission_mode: PermissionMode,
    pub thinking_mode: ThinkingMode,
    pub execution_admission: Option<Rc<dyn AgentExecutionAdmission>>,
    pub command: String,
    pub images: Option<Vec<AgentAttachment>>,
    pub endpoint: DirectEndpointRuntime,
    pub operation: AgentRuntimeOperation,
}

pub type SessionActivated = Rc<dyn Fn(&DirectStartedSession) -> ExecutorResult<()>>;

pub struct DirectStartRequest {
    pub execution: DirectExecutionRequest,
    pub on_session_activated: Option<SessionActivated>,
}

pub struct DirectResumeRequest {
    pub execution: DirectExecutionRequest,
    pub agent_session_id: String,
    pub native_session: Option<AgentNativeSessionRef>,
}

pub struct DirectStartedSession {
    pub agent_session_id: String,
    pub native_session: AgentNativeSessionRef,
}

pub fn assert_direct_execution_open(request: &DirectExecutionRequest) -> ExecutorResult<()> {
    if let Some(admission) = &request.execution_admission {
        admission::assert_execution_open(admission.as_ref())?;
    }
    Ok(())
}

pub async fn mark_direct_execution_started(request: &DirectExecutionRequest) -> ExecutorResult<()> {
    if let Some(admission) = &request.execution_admission {
        admission::mark_execution_started(admission.as_ref()).await?;
    }
    Ok(())
}
