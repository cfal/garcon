//! Controller-side session option types. The stored chat entry and its
//! carryover references are projected from the chats registry at assembly.

use std::{error::Error, rc::Rc};

use indexmap::{IndexMap, IndexSet};
use serde::Serialize;

use garcon_contract::{
    agent_execution::{AgentAttachment, AgentEndpointSelection},
    agent_integration::AgentSettingsEnvelope,
    api_providers::ApiProtocol,
    async_user_questions::AsyncQuestionReply,
    chat_modes::{
        DEFAULT_PERMISSION_MODE, DEFAULT_THINKING_MODE, PermissionMode, ThinkingMode,
        normalize_permission_mode, normalize_thinking_mode,
    },
    ws_requests::AgentCommandImage,
};
use garcon_interface::{
    execution::AgentExecutionAdmission, execution_v5::AgentExecutionSubmission,
    transcript::AgentNativeSessionRef,
};
use garcon_js::{Number, OptionalNullable, json::Opaque};
use serde_json::Value;

pub use crate::command_ledger::{NativeForkCleanup, StartedAgentSession};
use crate::{
    turn_identity::{TurnCommandType, TurnIdentity},
    types::ExecutionOperationResult,
};

#[derive(Debug, Clone, Default)]
pub struct PersistedChatExecutionConfig {
    pub executor_id: OptionalNullable<String>,
    pub project_path: Option<String>,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub thinking_mode: Option<String>,
    pub agent_settings_by_id: Option<IndexMap<String, AgentSettingsEnvelope>>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequiredChatExecutionConfig {
    #[serde(skip_serializing_if = "OptionalNullable::is_absent")]
    pub executor_id: OptionalNullable<String>,
    pub project_path: String,
    pub model: String,
    pub permission_mode: PermissionMode,
    pub thinking_mode: ThinkingMode,
    pub agent_settings_by_id: IndexMap<String, AgentSettingsEnvelope>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MissingChatExecutionConfig {
    #[error("Session not initialized: {0}")]
    Session(String),
    #[error("Chat {0} is missing projectPath")]
    ProjectPath(String),
    #[error("Chat {0} is missing model")]
    Model(String),
}

pub fn require_chat_execution_config(
    chat_id: &str,
    entry: Option<&PersistedChatExecutionConfig>,
) -> Result<RequiredChatExecutionConfig, MissingChatExecutionConfig> {
    let entry = entry.ok_or_else(|| MissingChatExecutionConfig::Session(chat_id.into()))?;
    let project_path = entry
        .project_path
        .as_ref()
        .filter(|path| !path.is_empty())
        .ok_or_else(|| MissingChatExecutionConfig::ProjectPath(chat_id.into()))?;
    let model = entry
        .model
        .as_ref()
        .filter(|model| !model.is_empty())
        .ok_or_else(|| MissingChatExecutionConfig::Model(chat_id.into()))?;
    Ok(RequiredChatExecutionConfig {
        executor_id: entry.executor_id.clone(),
        project_path: project_path.clone(),
        model: model.clone(),
        permission_mode: normalize_permission_mode(
            &mode_value(entry.permission_mode.as_deref()),
            DEFAULT_PERMISSION_MODE,
        ),
        thinking_mode: normalize_thinking_mode(
            &mode_value(entry.thinking_mode.as_deref()),
            DEFAULT_THINKING_MODE,
        ),
        agent_settings_by_id: entry.agent_settings_by_id.clone().unwrap_or_default(),
    })
}

fn mode_value(value: Option<&str>) -> Value {
    value.map_or(Value::Null, |value| Value::String(value.into()))
}

pub fn assert_execution_admission_open(
    admission: Option<&dyn AgentExecutionAdmission>,
    abort_reason: impl FnOnce() -> Box<dyn Error>,
) -> ExecutionOperationResult<()> {
    if admission.is_some_and(|admission| admission.signal().is_cancelled()) {
        return Err(abort_reason());
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq)]
pub enum PreparedAgentPrompt {
    NoDispatch,
    Dispatch {
        prompt: String,
        outbound_prompt: String,
        attachments: Vec<AgentAttachment>,
        excluded_ordinals: IndexSet<u64>,
        view_id: String,
        submission: Option<Box<AgentExecutionSubmission>>,
    },
}

#[derive(Debug, Clone)]
pub struct AgentSessionSettingsPatch {
    pub permission_mode: Option<PermissionMode>,
    pub thinking_mode: Option<ThinkingMode>,
    pub agent_settings_patch: Option<IndexMap<String, Opaque>>,
    pub model: Option<String>,
    pub api_provider_id: OptionalNullable<String>,
    pub model_endpoint_id: OptionalNullable<String>,
    pub model_protocol: OptionalNullable<ApiProtocol>,
}

impl Default for AgentSessionSettingsPatch {
    fn default() -> Self {
        Self {
            permission_mode: None,
            thinking_mode: None,
            agent_settings_patch: None,
            model: None,
            api_provider_id: OptionalNullable::ABSENT,
            model_endpoint_id: OptionalNullable::ABSENT,
            model_protocol: OptionalNullable::ABSENT,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ForkedAgentSessionOutcome {
    Materialized {
        session: StartedAgentSession,
        cleanup: Box<NativeForkCleanup>,
    },
    Unmaterialized,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PrepareProjectPathUpdateRequest {
    pub chat_id: String,
    pub agent_session_id: Option<String>,
    pub previous_project_path: String,
    pub next_project_path: String,
    pub native_session: Option<AgentNativeSessionRef>,
}

#[derive(Debug, Clone)]
pub struct StartAgentSessionRequest {
    pub chat_id: String,
    pub command: String,
    pub project_path: String,
    pub images: Option<Vec<AgentCommandImage>>,
    pub model: Option<String>,
    pub permission_mode: Option<PermissionMode>,
    pub thinking_mode: Option<ThinkingMode>,
    pub agent_settings: Option<AgentSettingsEnvelope>,
}

#[derive(Debug, Clone)]
pub struct RunAgentTurnRequest {
    pub chat_id: String,
    pub command: String,
    pub images: Option<Vec<AgentCommandImage>>,
    pub model: Option<String>,
    pub api_provider_id: OptionalNullable<String>,
    pub model_endpoint_id: OptionalNullable<String>,
    pub model_protocol: OptionalNullable<ApiProtocol>,
    pub permission_mode: Option<PermissionMode>,
    pub thinking_mode: Option<ThinkingMode>,
    pub agent_settings: Option<AgentSettingsEnvelope>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContextPreparationPhase {
    CompactingContext,
    StartingAgent,
}

pub type ContextPreparationListener =
    Rc<dyn Fn(ContextPreparationPhase) -> ExecutionOperationResult<()>>;

#[derive(Clone)]
pub struct StartSessionOptions {
    pub on_context_preparation: Option<ContextPreparationListener>,
    pub images: Option<Vec<AgentCommandImage>>,
    pub model: Option<String>,
    pub permission_mode: Option<PermissionMode>,
    pub thinking_mode: Option<ThinkingMode>,
    pub agent_settings: Option<AgentSettingsEnvelope>,
    pub project_path: Option<String>,
    pub client_request_id: Option<String>,
    pub client_message_id: Option<String>,
    pub turn_id: Option<String>,
    pub command_type: Option<TurnCommandType>,
    pub execution_admission: Option<Rc<dyn AgentExecutionAdmission>>,
    pub api_provider_id: OptionalNullable<String>,
    pub model_endpoint_id: OptionalNullable<String>,
    pub dispatch_deadline: Option<f64>,
}

#[derive(Clone)]
pub struct RunAgentTurnOptions {
    pub images: Option<Vec<AgentCommandImage>>,
    pub model: Option<String>,
    pub api_provider_id: OptionalNullable<String>,
    pub model_endpoint_id: OptionalNullable<String>,
    pub model_protocol: OptionalNullable<ApiProtocol>,
    pub permission_mode: Option<PermissionMode>,
    pub thinking_mode: Option<ThinkingMode>,
    pub agent_settings: Option<AgentSettingsEnvelope>,
    pub question_reply: Option<AsyncQuestionReply>,
    pub client_request_id: Option<String>,
    pub client_message_id: Option<String>,
    pub transcript_view_id: Option<String>,
    pub excluded_resend_ordinals: Option<Vec<Number>>,
    pub turn_id: Option<String>,
    pub command_type: Option<TurnCommandType>,
    pub execution_admission: Option<Rc<dyn AgentExecutionAdmission>>,
    pub integration_endpoint: OptionalNullable<AgentEndpointSelection>,
    pub created_at: Option<String>,
}

impl Default for RunAgentTurnOptions {
    fn default() -> Self {
        Self {
            images: None,
            model: None,
            api_provider_id: OptionalNullable::ABSENT,
            model_endpoint_id: OptionalNullable::ABSENT,
            model_protocol: OptionalNullable::ABSENT,
            permission_mode: None,
            thinking_mode: None,
            agent_settings: None,
            question_reply: None,
            client_request_id: None,
            client_message_id: None,
            transcript_view_id: None,
            excluded_resend_ordinals: None,
            turn_id: None,
            command_type: None,
            execution_admission: None,
            integration_endpoint: OptionalNullable::ABSENT,
            created_at: None,
        }
    }
}

impl RunAgentTurnOptions {
    pub(crate) fn identity(&self) -> TurnIdentity {
        TurnIdentity {
            turn_id: self.turn_id.clone(),
            client_request_id: self.client_request_id.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentSteerOptions {
    pub question_reply: Option<AsyncQuestionReply>,
    pub client_request_id: String,
    pub client_message_id: String,
    pub transcript_view_id: String,
}
