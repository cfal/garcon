use garcon_js::{OptionalNullable, json::Opaque};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize, Serializer};

use crate::{
    agent_integration::AgentSettingsEnvelope,
    chat_execution_control::ChatExecutionControlState,
    chat_id::ChatId,
    chat_list::ChatListEntry,
    chat_modes::{PermissionMode, ThinkingMode},
    chat_parentage::ChatLineage,
    chat_stop::ChatStopOutcome,
    chat_tag_mutations::CommandTagMutationOutcome,
    error_codes::ErrorCode,
    http_error::HttpErrorResponse,
};

use super::CommandRoutingOverrides;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandStatus {
    Accepted,
    Duplicate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandErrorCode(ErrorCode);

const COMMAND_ERROR_CODES: &[ErrorCode] = &[
    ErrorCode::VALIDATION_FAILED,
    ErrorCode::SESSION_NOT_FOUND,
    ErrorCode::IDEMPOTENCY_CONFLICT,
    ErrorCode::CHAT_ID_COLLISION,
    ErrorCode::QUEUE_ENTRY_NOT_FOUND,
    ErrorCode::QUEUE_ENTRY_ALREADY_SENT,
    ErrorCode::QUEUE_ENTRY_IN_FLIGHT,
    ErrorCode::QUEUE_ENTRY_REVISION_CONFLICT,
    ErrorCode::QUEUE_ENTRY_REORDER_CONFLICT,
    ErrorCode::QUEUE_ATTACHMENTS_FULL,
    ErrorCode::QUEUE_PAUSE_CHANGED,
    ErrorCode::STEER_NOT_DELIVERED,
    ErrorCode::STEER_OUTCOME_UNKNOWN,
    ErrorCode::STEER_PROVIDER_REJECTED,
    ErrorCode::STEER_TURN_UNAVAILABLE,
    ErrorCode::STEER_TURN_CHANGED,
    ErrorCode::STEER_TURN_NOT_STEERABLE,
    ErrorCode::STEER_CAPACITY_EXHAUSTED,
    ErrorCode::QUEUE_STEER_FINALIZATION_FAILED,
    ErrorCode::QUEUE_STEER_RECOVERY_FAILED,
    ErrorCode::PERMISSION_NOT_ACTIONABLE,
    ErrorCode::PERMISSION_DECISION_NOT_DELIVERED,
    ErrorCode::PERMISSION_DECISION_OUTCOME_UNKNOWN,
    ErrorCode::UNSUPPORTED_AGENT,
    ErrorCode::EXPECTED_AGENT_MISMATCH,
    ErrorCode::EXPLICIT_BYPASS_REQUIRED,
    ErrorCode::INCOMPLETE_EXECUTION_CONFIG,
    ErrorCode::STALE_CHAT_OWNERSHIP,
    ErrorCode::OWNERSHIP_TRANSFER_PENDING,
    ErrorCode::AGENT_HANDOFF_REQUIRES_IDLE,
    ErrorCode::CARRYOVER_COMPACTION_REQUIRED,
    ErrorCode::CARRYOVER_COMPACTION_UNAVAILABLE,
    ErrorCode::CARRYOVER_COMPACTION_FAILED,
    ErrorCode::SOURCE_TRANSCRIPT_UNAVAILABLE,
    ErrorCode::CARRYOVER_HISTORY_UNAVAILABLE,
    ErrorCode::CONTEXT_ENVELOPE_MISMATCH,
    ErrorCode::PREAMBLE_SLASH_COMMAND_BLOCKED,
    ErrorCode::PREAMBLE_SELECTION_COMPOSITION_INVALID,
    ErrorCode::CHAT_DELETED,
    ErrorCode::OPERATION_UNSUPPORTED,
    ErrorCode::SOURCE_REVISION_CHANGED,
    ErrorCode::TRANSCRIPT_UNAVAILABLE,
    ErrorCode::TRANSCRIPT_NOT_YET_PERSISTED,
    ErrorCode::STALE_TRANSCRIPT_VIEW,
    ErrorCode::AGENT_RESUME_NOT_DELEGATED,
    ErrorCode::AGENT_STOP_NOT_DELEGATED,
    ErrorCode::PROJECT_PATH_UPDATE_UNSUPPORTED,
    ErrorCode::PROJECT_PATH_DESTINATION_REJECTED,
    ErrorCode::PROJECT_PATH_UPDATE_OUTCOME_UNKNOWN,
    ErrorCode::PROJECT_PATH_UPDATE_FAILED,
    ErrorCode::CHAT_NOT_IDLE,
    ErrorCode::PROJECT_PATH_OUTSIDE_BASE,
    ErrorCode::PROJECT_PATH_NOT_FOUND,
    ErrorCode::PROJECT_PATH_NOT_DIRECTORY,
    ErrorCode::PROJECT_PATH_NATIVE_PATH_UNRESOLVED,
    ErrorCode::PROJECT_UNAVAILABLE,
    ErrorCode::SESSION_BUSY,
    ErrorCode::REQUEST_NOT_FOUND,
    ErrorCode::SERVER_SHUTTING_DOWN,
    ErrorCode::EXECUTOR_UNAVAILABLE,
    ErrorCode::EXECUTOR_BUSY,
    ErrorCode::INTERNAL_ERROR,
];

impl TryFrom<ErrorCode> for CommandErrorCode {
    type Error = ErrorCode;

    fn try_from(code: ErrorCode) -> Result<Self, Self::Error> {
        if COMMAND_ERROR_CODES.contains(&code) {
            Ok(Self(code))
        } else {
            Err(code)
        }
    }
}

impl From<CommandErrorCode> for ErrorCode {
    fn from(code: CommandErrorCode) -> Self {
        code.0
    }
}

impl Serialize for CommandErrorCode {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.0.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandAcceptedResponse {
    pub success: bool,
    pub command_type: String,
    pub client_request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<ChatId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub status: CommandStatus,
    pub accepted_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag_mutation: Option<CommandTagMutationOutcome>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurnAcknowledgement<K = String> {
    pub success: bool,
    pub command_type: K,
    pub client_request_id: String,
    pub chat_id: ChatId,
    pub turn_id: String,
    pub status: CommandStatus,
    pub accepted_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag_mutation: Option<CommandTagMutationOutcome>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialChatRelationships {
    #[serde(skip_serializing_if = "OptionalNullable::is_absent")]
    pub parent_chat_id: OptionalNullable<ChatId>,
    #[serde(skip_serializing_if = "OptionalNullable::is_absent")]
    pub lineage: OptionalNullable<ChatLineage>,
}

impl Default for PartialChatRelationships {
    fn default() -> Self {
        Self {
            parent_chat_id: OptionalNullable::ABSENT,
            lineage: OptionalNullable::ABSENT,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AgentTurnCommandResponse {
    #[serde(flatten)]
    pub accepted: AgentTurnAcknowledgement,
    #[serde(flatten)]
    pub relationships: PartialChatRelationships,
    #[serde(skip_serializing_if = "OptionalNullable::is_absent")]
    pub chat: OptionalNullable<ChatListEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StartChatCommandResponse {
    #[serde(flatten)]
    pub accepted: AgentTurnAcknowledgement,
    #[serde(flatten)]
    pub relationships: PartialChatRelationships,
    pub chat: Option<ChatListEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ForkChatResponse {
    pub success: bool,
    pub chat: ChatListEntry,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ForkRunCommandResponse {
    #[serde(flatten)]
    pub accepted: AgentTurnAcknowledgement,
    #[serde(flatten)]
    pub relationships: PartialChatRelationships,
    pub chat: ChatListEntry,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandErrorResponse {
    pub success: bool,
    pub error: String,
    pub error_code: CommandErrorCode,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHandoffCommandResponse {
    pub success: bool,
    pub chat_id: ChatId,
    pub chat: ChatListEntry,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntryCommandResponse {
    #[serde(flatten)]
    pub accepted: CommandAcceptedResponse,
    pub entry_id: String,
    pub control: ChatExecutionControlState,
}

pub type QueueEntryDeleteResponse = QueueEntryCommandResponse;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SteerCommandType {
    Steer,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SteerCommandResponse {
    #[serde(flatten)]
    pub accepted: AgentTurnAcknowledgement<SteerCommandType>,
    #[serde(flatten)]
    pub relationships: PartialChatRelationships,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QueuedSteerDelivery {
    Queued,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedSteerCommandResponse {
    pub success: bool,
    pub command_type: SteerCommandType,
    pub client_request_id: String,
    pub chat_id: ChatId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    pub status: CommandStatus,
    pub accepted_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag_mutation: Option<CommandTagMutationOutcome>,
    pub delivery: QueuedSteerDelivery,
    pub entry_id: String,
    pub control: ChatExecutionControlState,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntrySteerCommandResponse {
    #[serde(flatten)]
    pub steer: SteerCommandResponse,
    pub server_instance_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub control: Option<ChatExecutionControlState>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedQueueEntrySteerCommandResponse {
    #[serde(flatten)]
    pub steer: QueuedSteerCommandResponse,
    pub server_instance_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SteerDeliveryOutcome {
    NotSent,
    Unknown,
    Accepted,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntrySteerErrorResponse {
    #[serde(flatten)]
    pub error: CommandErrorResponse,
    pub delivery_outcome: SteerDeliveryOutcome,
    pub server_instance_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub control: Option<ChatExecutionControlState>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QueueCommandErrorResponse {
    #[serde(flatten)]
    pub error: HttpErrorResponse,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub control: Option<ChatExecutionControlState>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueMutationResponse {
    pub success: bool,
    pub chat_id: ChatId,
    pub control: ChatExecutionControlState,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AgentStopResponse {
    #[serde(flatten)]
    pub accepted: CommandAcceptedResponse,
    pub outcome: ChatStopOutcome,
    pub control: ChatExecutionControlState,
    #[serde(flatten)]
    pub relationships: PartialChatRelationships,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AgentInterruptAndSendResponse {
    #[serde(flatten)]
    pub accepted: CommandAcceptedResponse,
    pub outcome: ChatStopOutcome,
    pub control: ChatExecutionControlState,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionSettingsPatchResponse {
    pub success: bool,
    pub chat_id: ChatId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_mode: Option<ThinkingMode>,
    pub agent_settings: AgentSettingsEnvelope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPatchResponse {
    pub success: bool,
    pub chat_id: ChatId,
    pub model: String,
    #[serde(flatten)]
    pub routing: CommandRoutingOverrides,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPathPatchResponse {
    pub success: bool,
    pub chat_id: ChatId,
    pub project_path: String,
    pub effective_project_key: String,
    pub previous_project_path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RunningChatEntry {
    pub id: ChatId,
    #[serde(flatten)]
    pub fields: IndexMap<String, Opaque>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RunningChatsResponse {
    pub sessions: IndexMap<String, Vec<RunningChatEntry>>,
}
