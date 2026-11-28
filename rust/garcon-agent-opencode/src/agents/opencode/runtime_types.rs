//! Ports `server-agents/opencode/src/agents/opencode/runtime-types.ts`.

use std::rc::Rc;

use garcon_agents_common::execution::runtime_events::AgentRuntimeOperation;
use garcon_contract::{
    agent_execution::AgentAttachment,
    chat_command_contracts::PermissionDecisionPayload,
    chat_modes::{PermissionMode, ThinkingMode},
};
use garcon_interface::{execution::AgentExecutionAdmission, resources::ExecutorResult};

use crate::js::AbortSignal;

#[derive(Clone)]
pub struct OpenCodeExecutionRequest {
    pub chat_id: String,
    pub project_path: String,
    pub model: Option<String>,
    pub permission_mode: PermissionMode,
    pub thinking_mode: Option<ThinkingMode>,
    pub execution_admission: Option<Rc<dyn AgentExecutionAdmission>>,
    pub operation: AgentRuntimeOperation,
}

pub type OnSessionActivated = Rc<dyn Fn(&str)>;

pub struct OpenCodeStartRequest {
    pub execution: OpenCodeExecutionRequest,
    pub command: String,
    pub images: Vec<AgentAttachment>,
    pub on_session_activated: Option<OnSessionActivated>,
}

pub struct OpenCodeResumeRequest {
    pub start: OpenCodeStartRequest,
    pub agent_session_id: String,
}

#[derive(Debug, Clone, Default)]
pub struct OpenCodeSessionSettingsPatch {
    pub permission_mode: Option<PermissionMode>,
    pub thinking_mode: Option<ThinkingMode>,
    pub model: Option<String>,
}

pub type OpenCodePermissionDecision = PermissionDecisionPayload;

pub fn assert_open_code_execution_open(request: &OpenCodeExecutionRequest) -> ExecutorResult<()> {
    if let Some(admission) = &request.execution_admission {
        AbortSignal::from_token(admission.signal().clone()).throw_if_aborted()?;
    }
    Ok(())
}

pub async fn mark_open_code_execution_started(
    request: &OpenCodeExecutionRequest,
) -> ExecutorResult<()> {
    assert_open_code_execution_open(request)?;
    if let Some(admission) = &request.execution_admission {
        admission.mark_started().await?;
    }
    Ok(())
}
