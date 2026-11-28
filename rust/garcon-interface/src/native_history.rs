//! Ports `server-agents/interface/src/contracts/native-history.ts`.

use async_trait::async_trait;
use futures::stream::LocalBoxStream;
use garcon_contract::chat_types::ChatMessage;
use garcon_js::json::Opaque;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::{
    producer::{deserialize_message, deserialize_provider_meta},
    resources::{AgentInstanceCallOptions, ExecutorResult},
    transcript::{AgentChatReference, AgentNativeSessionRef, AgentTranscriptSourceLocation},
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentImportedTranscriptRow {
    #[serde(deserialize_with = "deserialize_message")]
    pub message: ChatMessage,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_provider_meta"
    )]
    pub provider_meta: Option<Opaque>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentHistoryImportRequest {
    pub chat: AgentChatReference,
    #[serde(skip)]
    pub signal: CancellationToken,
}

pub type AgentHistoryStream<'a> =
    LocalBoxStream<'a, ExecutorResult<Vec<AgentImportedTranscriptRow>>>;

pub trait AgentHistoryImport {
    fn load(
        &self,
        request: AgentHistoryImportRequest,
        options: Option<AgentInstanceCallOptions>,
    ) -> AgentHistoryStream<'_>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentNativeSessionReleaseReason {
    Deleted,
    Transferred,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentNativeSessionReleaseRequest {
    #[serde(flatten)]
    pub request: AgentHistoryImportRequest,
    pub reason: AgentNativeSessionReleaseReason,
}

#[async_trait(?Send)]
pub trait AgentNativeSessionAccess {
    async fn resolve_native_session(
        &self,
        request: AgentHistoryImportRequest,
    ) -> ExecutorResult<Option<AgentNativeSessionRef>>;
    async fn describe_source(
        &self,
        request: AgentHistoryImportRequest,
    ) -> ExecutorResult<Option<AgentTranscriptSourceLocation>>;
    async fn release(&self, request: AgentNativeSessionReleaseRequest) -> ExecutorResult<()>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentNativeActivity {
    pub last_entry_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AgentNativeActivityResult {
    Ready { value: AgentNativeActivity },
    Unavailable,
}

#[async_trait(?Send)]
pub trait AgentNativeActivityProbe {
    async fn last_activity(
        &self,
        native_session: AgentNativeSessionRef,
        signal: CancellationToken,
    ) -> ExecutorResult<AgentNativeActivityResult>;
}
