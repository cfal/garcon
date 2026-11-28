//! Ports `server-agents/common/src/acp/runtime-types.ts`.

use std::collections::BTreeMap;
use std::rc::Rc;

use garcon_contract::agent_execution::AgentAttachment;
use garcon_contract::chat_modes::{PermissionMode, ThinkingMode};
use garcon_interface::execution::AgentExecutionAdmission;
use garcon_interface::resources::ExecutorResult;

use crate::execution::{admission, runtime_events::AgentRuntimeOperation};

pub struct AcpExecutionRequest {
    pub chat_id: String,
    pub project_path: String,
    pub model: String,
    pub permission_mode: PermissionMode,
    pub thinking_mode: ThinkingMode,
    pub operation: AgentRuntimeOperation,
    pub execution_admission: Option<Rc<dyn AgentExecutionAdmission>>,
    pub command: String,
    pub images: Option<Vec<AgentAttachment>>,
    pub env_overrides: BTreeMap<String, String>,
}

pub type SessionActivated = Rc<dyn Fn(&AcpStartedSession) -> ExecutorResult<()>>;

pub struct AcpStartRequest {
    pub execution: AcpExecutionRequest,
    pub on_session_activated: Option<SessionActivated>,
}

pub struct AcpResumeRequest {
    pub execution: AcpExecutionRequest,
    pub agent_session_id: String,
    pub native_path: Option<String>,
}

pub struct AcpStartedSession {
    pub agent_session_id: String,
    pub native_path: Option<String>,
}

#[derive(Default)]
pub struct AcpSessionSettingsPatch {
    pub permission_mode: Option<PermissionMode>,
    pub thinking_mode: Option<ThinkingMode>,
    pub model: Option<String>,
}

pub struct AcpProjectPathUpdateRequest {
    pub chat_id: String,
    pub agent_session_id: Option<String>,
    pub previous_project_path: String,
    pub next_project_path: String,
    pub native_path: Option<String>,
}

pub fn assert_acp_execution_open(request: &AcpExecutionRequest) -> ExecutorResult<()> {
    if let Some(admission) = &request.execution_admission {
        admission::assert_execution_open(admission.as_ref())?;
    }
    Ok(())
}

pub async fn mark_acp_execution_started(request: &AcpExecutionRequest) -> ExecutorResult<()> {
    if let Some(admission) = &request.execution_admission {
        admission::mark_execution_started(admission.as_ref()).await?;
    }
    Ok(())
}
