//! Ports `server-agents/interface/src/contracts/execution-v5.ts`.

use async_trait::async_trait;
use garcon_contract::{
    agent_execution::{AgentAttachment, AgentEndpointSelection},
    agent_integration::AgentSettingsEnvelope,
    async_user_questions::AsyncQuestionReply,
    chat_modes::{PermissionMode, ThinkingMode},
    chat_types::{UserMessagePresentation, parse_user_message_presentation},
    transcript_seed::CarriedContext,
};
use serde::{Deserialize, Deserializer, Serialize, de::Error};
use serde_json::Value;

use crate::{
    execution::AgentRunningSession,
    resources::{AgentProducerBinding, AgentResourceRef, ExecutorCallOptions, ExecutorResult},
    transcript::AgentNativeSessionRef,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentExecutionKind {
    Execution,
}

pub type AgentExecutionHandle = AgentResourceRef<AgentExecutionKind>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentExecutionSubmission {
    pub client_message_id: Option<String>,
    pub timestamp: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_presentation"
    )]
    pub presentation: Option<UserMessagePresentation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question_reply: Option<AsyncQuestionReply>,
}

fn deserialize_presentation<'de, D: Deserializer<'de>>(
    wire: D,
) -> Result<Option<UserMessagePresentation>, D::Error> {
    let raw = Value::deserialize(wire)?;
    parse_user_message_presentation(Some(&raw)).map_err(D::Error::custom)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentExecutionContextV5 {
    pub chat_id: String,
    pub project_path: String,
    pub model: String,
    pub permission_mode: PermissionMode,
    pub thinking_mode: ThinkingMode,
    pub settings: AgentSettingsEnvelope,
    pub endpoint: Option<AgentEndpointSelection>,
    pub run_id: String,
    pub producer_binding: AgentProducerBinding,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submission: Option<AgentExecutionSubmission>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStartRequestV5 {
    #[serde(flatten)]
    pub context: AgentExecutionContextV5,
    pub prompt: String,
    pub attachments: Vec<AgentAttachment>,
    pub carried_context: Option<CarriedContext>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentResumeRequestV5 {
    #[serde(flatten)]
    pub context: AgentExecutionContextV5,
    pub agent_session_id: String,
    pub native_session: Option<AgentNativeSessionRef>,
    pub prompt: String,
    pub attachments: Vec<AgentAttachment>,
}

#[async_trait(?Send)]
pub trait AgentExecutionV5 {
    async fn start(
        &self,
        request: AgentStartRequestV5,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<AgentExecutionHandle>;
    async fn resume(
        &self,
        request: AgentResumeRequestV5,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<AgentExecutionHandle>;
    async fn abort(
        &self,
        handle: AgentExecutionHandle,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<bool>;
    async fn running_sessions(
        &self,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Vec<AgentRunningSession>>;
}
