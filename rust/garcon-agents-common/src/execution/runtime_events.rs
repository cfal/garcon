//! Ports `server-agents/common/src/execution/runtime-events.ts`.

use std::{any::Any, rc::Rc};

use async_trait::async_trait;
use futures::future::LocalBoxFuture;
use garcon_contract::{
    agent_execution::{AgentAttachment, AgentEndpointSelection},
    agent_integration::AgentSettingsEnvelope,
    async_user_questions::AsyncQuestionReply,
    chat_command_contracts::PermissionDecisionPayload,
    chat_modes::{PermissionMode, ThinkingMode},
    chat_types::ChatMessage,
    command_output::CommandWorkingDirectory,
    transcript_seed::CarriedContext,
};
use garcon_interface::{
    execution::{AgentExecutionAdmission, AgentRunningSession},
    execution_v5::{AgentExecutionContextV5, AgentExecutionSubmission},
    native_message_source::NativeSourced,
    producer::{
        AgentEstablishedSession, AgentFinalResponse, AgentProducedRow,
        AgentProviderPermissionLifecycle, AgentRunFailureDetail,
    },
    resources::ExecutorResult,
    transcript::AgentNativeSessionRef,
};

use crate::native_session::provider_metadata::provider_metadata;

pub struct AgentRuntimeExecutionContext {
    pub chat_id: String,
    pub project_path: String,
    pub model: String,
    pub permission_mode: PermissionMode,
    pub thinking_mode: ThinkingMode,
    pub settings: AgentSettingsEnvelope,
    pub endpoint: Option<AgentEndpointSelection>,
    pub run_id: String,
    pub submission: Option<AgentExecutionSubmission>,
    pub admission: Rc<dyn AgentExecutionAdmission>,
}

impl AgentRuntimeExecutionContext {
    pub(super) fn new(
        context: AgentExecutionContextV5,
        admission: Rc<dyn AgentExecutionAdmission>,
    ) -> Self {
        let AgentExecutionContextV5 {
            chat_id,
            project_path,
            model,
            permission_mode,
            thinking_mode,
            settings,
            endpoint,
            run_id,
            producer_binding: _,
            submission,
        } = context;
        Self {
            chat_id,
            project_path,
            model,
            permission_mode,
            thinking_mode,
            settings,
            endpoint,
            run_id,
            submission,
            admission,
        }
    }
}

pub struct AgentRuntimeStartRequest {
    pub context: AgentRuntimeExecutionContext,
    pub prompt: String,
    pub attachments: Vec<AgentAttachment>,
    pub carried_context: Option<CarriedContext>,
}

pub struct AgentRuntimeResumeRequest {
    pub context: AgentRuntimeExecutionContext,
    pub agent_session_id: String,
    pub native_session: Option<AgentNativeSessionRef>,
    pub prompt: String,
    pub attachments: Vec<AgentAttachment>,
}

#[async_trait(?Send)]
pub trait RuntimePermissionResponse {
    fn permission_occurrence_id(&self) -> &str;
    async fn respond(&self, decision: PermissionDecisionPayload) -> ExecutorResult<()>;
}

pub type RuntimeSteerTarget = Rc<dyn Any>;
pub type PrepareDelivery = Rc<dyn Fn() -> LocalBoxFuture<'static, ExecutorResult<()>>>;

pub struct RuntimeSteerRequest {
    pub question_reply: Option<AsyncQuestionReply>,
    pub chat_id: String,
    pub project_path: String,
    pub agent_session_id: String,
    pub native_session: Option<AgentNativeSessionRef>,
    pub target: Option<RuntimeSteerTarget>,
    pub input: String,
    pub client_message_id: String,
    pub prepare_delivery: PrepareDelivery,
}

pub enum ProviderRunOutcome {
    Finished {
        final_response: Option<AgentFinalResponse>,
    },
    Failed {
        error: Option<AgentRunFailureDetail>,
    },
}

pub enum AgentRuntimeEvent {
    Rows {
        rows: Vec<AgentProducedRow>,
    },
    Session {
        session: AgentEstablishedSession,
    },
    Notice {
        run_id: String,
        content: String,
        title: Option<String>,
    },
    Permission {
        run_id: String,
        lifecycle: AgentProviderPermissionLifecycle,
        decision: Option<Rc<dyn RuntimePermissionResponse>>,
    },
    RunEnded {
        run_id: String,
        outcome: ProviderRunOutcome,
        working_directory: Option<CommandWorkingDirectory>,
    },
    Steerable,
}

pub type AgentRuntimePublisher = Rc<dyn Fn(AgentRuntimeEvent)>;

#[derive(Clone)]
pub struct AgentRuntimeOperation {
    pub run_id: String,
    pub publish: AgentRuntimePublisher,
}

pub fn runtime_operation(run_id: String, publish: AgentRuntimePublisher) -> AgentRuntimeOperation {
    AgentRuntimeOperation { run_id, publish }
}

#[async_trait(?Send)]
pub trait AgentRuntimeExecution {
    async fn start(
        &self,
        request: AgentRuntimeStartRequest,
        publish: AgentRuntimePublisher,
    ) -> ExecutorResult<AgentEstablishedSession>;
    async fn resume(
        &self,
        request: AgentRuntimeResumeRequest,
        publish: AgentRuntimePublisher,
    ) -> ExecutorResult<()>;
    async fn abort(&self, agent_session_id: &str) -> ExecutorResult<bool>;
    fn running_sessions(&self) -> Vec<AgentRunningSession>;
}

pub fn runtime_rows(
    messages: impl IntoIterator<Item = NativeSourced<ChatMessage>>,
) -> Vec<AgentProducedRow> {
    messages
        .into_iter()
        .map(|message| {
            let provider_meta = provider_metadata(&message);
            AgentProducedRow {
                message: message.value,
                provider_meta,
            }
        })
        .collect()
}
