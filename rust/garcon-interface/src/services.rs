//! Ports `server-agents/interface/src/contracts/services.ts`.

use std::rc::Rc;

use async_trait::async_trait;
use garcon_contract::agent_auth::{
    AgentAuthLoginCompleteResult, AgentAuthLoginLaunchResult, AgentAuthLoginStatus,
};
use garcon_contract::agent_execution::{AgentAuthStatus, AgentEndpointSelection};
use garcon_contract::agent_integration::{AgentSettingDescriptor, AgentSettingsEnvelope};
use garcon_contract::agents::AgentModelOption;
use garcon_contract::async_user_questions::AsyncQuestionReply;
use garcon_contract::attachments::FileAttachmentMimeTypes;
use garcon_contract::chat_modes::ThinkingMode;
use garcon_contract::input_format::InputFormatByModel;
use garcon_contract::slash_commands::SlashCommand;
use garcon_js::{Number, json::Opaque};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::execution_v5::{AgentExecutionHandle, AgentResumeRequestV5};
use crate::resources::{
    AgentProducerBinding, AgentResourceRef, ExecutorCallOptions, ExecutorResult,
};
use crate::transcript::AgentNativeSessionRef;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLiteralExecution {
    pub selection_label: String,
    pub input_format_by_model: InputFormatByModel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentReadinessStatus {
    pub ready: bool,
    pub reason: String,
}

#[async_trait(?Send)]
pub trait AgentReadiness {
    async fn status(&self, signal: CancellationToken) -> ExecutorResult<AgentReadinessStatus>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "bool", into = "bool")]
pub struct RequireNativeDiscovery;

impl TryFrom<bool> for RequireNativeDiscovery {
    type Error = &'static str;

    fn try_from(value: bool) -> Result<Self, Self::Error> {
        value
            .then_some(Self)
            .ok_or("requireNativeDiscovery must be true")
    }
}

impl From<RequireNativeDiscovery> for bool {
    fn from(_: RequireNativeDiscovery) -> Self {
        true
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCatalogRequest {
    pub strict: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub require_native_discovery: Option<RequireNativeDiscovery>,
    #[serde(skip)]
    pub signal: CancellationToken,
    #[serde(skip)]
    pub timeout_ms: Option<f64>,
    #[serde(skip)]
    pub dispatch_deadline: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentGenerationModel {
    pub priority: Number,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCatalogSnapshot {
    pub models: Vec<AgentModelOption>,
    pub default_model: String,
    pub requires_strict_model_discovery: bool,
    pub generation: Option<AgentGenerationModel>,
}

#[async_trait(?Send)]
pub trait AgentCatalog {
    async fn snapshot(&self, request: AgentCatalogRequest) -> ExecutorResult<AgentCatalogSnapshot>;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAttachments {
    pub file_mime_types: FileAttachmentMimeTypes,
    pub inline_text_max_bytes: Option<Number>,
}

#[async_trait(?Send)]
pub trait AgentSettings {
    fn describe(&self) -> &[AgentSettingDescriptor];
    fn defaults(&self) -> ExecutorResult<AgentSettingsEnvelope>;
    fn parse(&self, input: AgentSettingsEnvelope) -> ExecutorResult<AgentSettingsEnvelope>;
    async fn migrate(&self, input: AgentSettingsEnvelope) -> ExecutorResult<AgentSettingsEnvelope>;
    fn apply_patch(
        &self,
        current: AgentSettingsEnvelope,
        patch: IndexMap<String, Opaque>,
    ) -> ExecutorResult<AgentSettingsEnvelope>;
}

#[async_trait(?Send)]
pub trait AgentEndpoints {
    async fn validate(
        &self,
        selection: AgentEndpointSelection,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()>;
}

#[async_trait(?Send)]
pub trait AgentAuth {
    async fn status(&self, signal: CancellationToken) -> ExecutorResult<AgentAuthStatus>;
    fn login_capabilities(&self) -> AgentAuthLoginCapabilities;
}

#[derive(Default)]
pub struct AgentAuthLoginCapabilities {
    pub launch_login: Option<Rc<dyn AgentAuthLaunchLogin>>,
    pub complete_login: Option<Rc<dyn AgentAuthCompleteLogin>>,
    pub login_status: Option<Rc<dyn AgentAuthLoginStatusReader>>,
}

#[async_trait(?Send)]
pub trait AgentAuthLaunchLogin {
    async fn launch_login(&self) -> ExecutorResult<AgentAuthLoginLaunchResult>;
}

#[async_trait(?Send)]
pub trait AgentAuthCompleteLogin {
    async fn complete_login(
        &self,
        session_id: &str,
        code: &str,
    ) -> ExecutorResult<AgentAuthLoginCompleteResult>;
}

#[async_trait(?Send)]
pub trait AgentAuthLoginStatusReader {
    async fn login_status(
        &self,
        expected_session_id: Option<&str>,
    ) -> ExecutorResult<AgentAuthLoginStatus>;
}

#[async_trait(?Send)]
pub trait AgentCommands {
    async fn discover(
        &self,
        project_path: &str,
        signal: CancellationToken,
    ) -> ExecutorResult<Vec<SlashCommand>>;
}

#[async_trait(?Send)]
pub trait AgentSteering {
    async fn capture_target(
        &self,
        request: AgentSteerTargetRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Option<AgentSteerTarget>>;
    async fn steer(
        &self,
        request: AgentSteerRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<AgentSteerResult>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentSteerTargetKind {
    SteerTarget,
}

pub type AgentSteerTarget = AgentResourceRef<AgentSteerTargetKind>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSteerTargetRequest {
    pub chat_id: String,
    pub agent_session_id: String,
    pub native_session: Option<AgentNativeSessionRef>,
    pub producer_binding: AgentProducerBinding,
    pub expected_run_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSteerRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question_reply: Option<AsyncQuestionReply>,
    pub chat_id: String,
    pub project_path: String,
    pub agent_session_id: String,
    pub native_session: Option<AgentNativeSessionRef>,
    pub target: Option<AgentSteerTarget>,
    pub input: String,
    pub client_message_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentSteerRejectionReason {
    NoActiveTurn,
    TurnChanged,
    TurnNotSteerable,
    InvalidInput,
    ProviderRejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentSteerFailureOutcome {
    NotSent,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AgentSteerResult {
    Accepted,
    Rejected {
        reason: AgentSteerRejectionReason,
        message: String,
    },
    Failed {
        outcome: AgentSteerFailureOutcome,
        message: String,
    },
}

#[async_trait(?Send)]
pub trait AgentCompaction {
    async fn compact(
        &self,
        request: AgentResumeRequestV5,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<AgentExecutionHandle>;
}

#[async_trait(?Send)]
pub trait AgentLifecycle {
    async fn start(&self) -> ExecutorResult<()>;
    async fn stop(&self) -> ExecutorResult<()>;
    async fn migrate_owned_storage(&self) -> ExecutorResult<()>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum AgentLegacyModelScope {
    Chat {
        record_id: String,
        selected_agent_id: String,
    },
    ScheduledPrompt {
        record_id: String,
        selected_agent_id: String,
    },
    RecentAgentSetting {
        record_id: String,
        selected_agent_id: String,
    },
    Handoff {
        record_id: String,
        selected_agent_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLegacyExecutionDefaultsScope {
    pub kind: AgentLegacyExecutionDefaultsKind,
    pub record_id: String,
    pub selected_agent_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentLegacyExecutionDefaultsKind {
    ExecutionDefaults,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AgentLegacySettingsScope {
    Model(AgentLegacyModelScope),
    ExecutionDefaults(AgentLegacyExecutionDefaultsScope),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTranslateLegacyModelRequest {
    pub scope: AgentLegacyModelScope,
    pub model: String,
    #[serde(skip)]
    pub signal: CancellationToken,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTranslateLegacyNativeSessionRequest {
    pub chat_id: String,
    pub project_path: String,
    pub model: String,
    pub agent_session_id: Option<String>,
    pub legacy_native_path: Option<String>,
    pub legacy_values: IndexMap<String, Opaque>,
    #[serde(skip)]
    pub signal: CancellationToken,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTranslateLegacySettingsRequest {
    pub scope: AgentLegacySettingsScope,
    pub legacy_values: IndexMap<String, Opaque>,
    #[serde(skip)]
    pub signal: CancellationToken,
}

#[async_trait(?Send)]
pub trait AgentMigration {
    async fn translate_legacy_model(
        &self,
        request: AgentTranslateLegacyModelRequest,
    ) -> ExecutorResult<String>;
    async fn translate_legacy_native_session(
        &self,
        request: AgentTranslateLegacyNativeSessionRequest,
    ) -> ExecutorResult<Option<AgentNativeSessionRef>>;
    async fn translate_legacy_settings(
        &self,
        request: AgentTranslateLegacySettingsRequest,
    ) -> ExecutorResult<Option<AgentSettingsEnvelope>>;
}

#[async_trait(?Send)]
pub trait AgentSingleQuery {
    async fn run(&self, request: AgentSingleQueryRequest) -> ExecutorResult<String>;
    fn runs_tools_without_permission(&self) -> bool;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSingleQueryRequest {
    pub prompt: String,
    pub model: String,
    pub thinking_mode: ThinkingMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<Number>,
    pub settings: AgentSettingsEnvelope,
    pub endpoint: Option<AgentEndpointSelection>,
    #[serde(skip)]
    pub signal: CancellationToken,
}
