//! Ports `server-agents/pi/src/agents/pi/runtime-types.ts`.

use std::rc::Rc;

use garcon_agents_common::execution::{
    admission::{assert_execution_open, mark_execution_started},
    runtime_events::AgentRuntimeOperation,
};
use garcon_contract::{
    agent_execution::AgentAttachment,
    chat_modes::{PermissionMode, ThinkingMode},
};
use garcon_interface::{execution::AgentExecutionAdmission, resources::ExecutorResult};
use indexmap::IndexMap;

pub struct PiExecutionRequest {
    pub chat_id: String,
    pub project_path: String,
    pub model: String,
    pub permission_mode: PermissionMode,
    pub thinking_mode: ThinkingMode,
    pub operation: AgentRuntimeOperation,
    pub execution_admission: Option<Rc<dyn AgentExecutionAdmission>>,
    pub command: String,
    pub images: Vec<AgentAttachment>,
    pub env_overrides: Option<IndexMap<String, String>>,
}

pub struct PiStartRequest {
    pub execution: PiExecutionRequest,
    pub on_session_activated: Option<Rc<OnSessionActivated>>,
}

pub type OnSessionActivated = dyn Fn(&PiStartedSession) -> ExecutorResult<()>;

pub struct PiResumeRequest {
    pub execution: PiExecutionRequest,
    pub agent_session_id: String,
    pub native_path: Option<String>,
}

#[derive(Clone)]
pub struct PiStartedSession {
    pub agent_session_id: String,
    pub native_path: Option<String>,
}

pub fn assert_pi_execution_open(request: &PiExecutionRequest) -> ExecutorResult<()> {
    if let Some(admission) = &request.execution_admission {
        assert_execution_open(admission.as_ref())?;
    }
    Ok(())
}

pub async fn mark_pi_execution_started(request: &PiExecutionRequest) -> ExecutorResult<()> {
    if let Some(admission) = &request.execution_admission {
        mark_execution_started(admission.as_ref()).await?;
    }
    Ok(())
}
