use std::rc::Rc;

use garcon_agents_common::execution::{
    admission::assert_execution_open, runtime_events::AgentRuntimeOperation,
};
use garcon_contract::{
    agent_execution::AgentAttachment,
    chat_modes::{ClaudeThinkingMode, PermissionMode, ThinkingMode},
};
use garcon_interface::{execution::AgentExecutionAdmission, resources::ExecutorResult};
use indexmap::IndexMap;

use crate::session_options::ClaudeSessionOptions;

pub struct ClaudeExecutionRequest {
    pub chat_id: String,
    pub project_path: String,
    pub model: String,
    pub permission_mode: PermissionMode,
    pub thinking_mode: ThinkingMode,
    pub claude_thinking_mode: Option<ClaudeThinkingMode>,
    pub execution_admission: Option<Rc<dyn AgentExecutionAdmission>>,
    pub command: String,
    pub images: Vec<AgentAttachment>,
    pub env_overrides: Option<IndexMap<String, String>>,
    pub operation: AgentRuntimeOperation,
}

impl ClaudeExecutionRequest {
    pub(crate) fn session_options(&self, agent_session_id: &str) -> ClaudeSessionOptions {
        ClaudeSessionOptions {
            agent_session_id: agent_session_id.to_owned(),
            session_id: agent_session_id.to_owned(),
            chat_id: self.chat_id.clone(),
            project_path: self.project_path.clone(),
            model: self.model.clone(),
            permission_mode: self.permission_mode,
            thinking_mode: self.thinking_mode,
            claude_thinking_mode: self.claude_thinking_mode,
            env_overrides: self.env_overrides.clone(),
        }
    }
}

pub struct ClaudeStartRequest {
    pub execution: ClaudeExecutionRequest,
    pub agent_session_id: String,
    pub on_session_activated: Option<Rc<dyn Fn()>>,
}

pub struct ClaudeResumeRequest {
    pub execution: ClaudeExecutionRequest,
    pub agent_session_id: String,
    pub native_path: Option<String>,
}

pub struct ClaudeProjectPathUpdate {
    pub chat_id: String,
    pub agent_session_id: Option<String>,
    pub previous_project_path: String,
    pub next_project_path: String,
    pub native_path: Option<String>,
}

pub fn assert_claude_execution_open(
    admission: Option<&dyn AgentExecutionAdmission>,
) -> ExecutorResult<()> {
    admission.map_or(Ok(()), assert_execution_open)
}
