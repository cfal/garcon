//! Ports `common/chat-command-contracts.ts`.

mod responses;
pub use responses::*;

use std::collections::HashSet;

use garcon_js::{
    OptionalNullable, is_safe_integer,
    json::{Opaque, as_number},
    trim,
};
use serde::{Deserialize, Deserializer, Serialize, de::Error};
use serde_json::{Map, Value};

use crate::chat_execution_command_parsing::{
    nullable_string, optional_agent_handoff_request, optional_agent_settings,
    optional_api_protocol, optional_permission_mode, optional_thinking_mode,
    required_agent_settings,
};
use crate::chat_fork_command_parsing::parse_handoff_fork_consent;
use crate::command_request_validation::{
    optional_chat_id, optional_non_empty_string, optional_record, optional_string, request_record,
    required_chat_id, required_command_correlation_id, required_content, required_queue_entry_id,
    required_string, required_string_content,
};
use crate::{
    agent_integration::AgentSettingsEnvelope,
    api_providers::ApiProtocol,
    async_user_questions::AsyncQuestionReply,
    chat_id::ChatId,
    chat_input_command_parsing::{
        CommandQuestionReplyField, parse_command_question_reply,
        parse_command_user_message_presentation, reject_question_reply,
    },
    chat_modes::{
        DEFAULT_PERMISSION_MODE, DEFAULT_THINKING_MODE, PermissionMode, ThinkingMode,
        normalize_permission_mode, normalize_thinking_mode,
    },
    chat_transient_feed::{ChatTransientControlAction, parse_chat_transient_control_action},
    executors::{ExecutorId, is_executor_id},
    preambles::{PREAMBLE_MAX_COUNT, PreambleId, is_preamble_id},
    tags::normalize_tags,
    user_message_presentation::UserMessagePresentation,
    ws_requests::AgentCommandImage,
};

pub use crate::ask_user_question_response::{
    ASK_USER_QUESTION_ID_MAX_BYTES, ASK_USER_QUESTION_MAX_ANSWERS,
    ASK_USER_QUESTION_MAX_SELECTED_OPTIONS, ASK_USER_QUESTION_REASON_MAX_BYTES,
    ASK_USER_QUESTION_RESPONSE_MAX_BYTES, AskUserQuestionAnswerPayload,
    AskUserQuestionDecisionResponse, normalize_ask_user_question_decision_response,
};
pub use crate::chat_execution_command_parsing::parse_agent_handoff_command_request;
pub use crate::chat_fork_command_parsing::{
    parse_delete_chat_command_request, parse_fork_chat_command_request,
};
pub use crate::command_request_validation::{
    COMMAND_CORRELATION_ID_MAX_BYTES, CommandRequestValidationError, QUEUE_ENTRY_ID_MAX_BYTES,
    is_command_correlation_id_within_limit, is_queue_entry_id_within_limit,
};

type ValidationError = CommandRequestValidationError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChatStartOrigin {
    AgentCommand,
    Interactive,
    Cli,
    Scheduled,
}

pub const CHAT_START_ORIGINS: &[ChatStartOrigin] = &[
    ChatStartOrigin::AgentCommand,
    ChatStartOrigin::Interactive,
    ChatStartOrigin::Cli,
    ChatStartOrigin::Scheduled,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClientChatStartOrigin {
    Interactive,
    Cli,
}

pub fn records_startup_preferences(origin: ChatStartOrigin) -> bool {
    origin == ChatStartOrigin::Interactive
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkChatCommandRequest {
    pub source_chat_id: ChatId,
    pub chat_id: ChatId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub up_to_ordinal: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_handoff_fork: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_view_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_request_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteChatCommandRequest {
    pub chat_id: ChatId,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartChatCommandRequest {
    pub origin: ClientChatStartOrigin,
    pub client_request_id: String,
    pub client_message_id: String,
    pub chat_id: ChatId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_chat_id: Option<ChatId>,
    pub agent_id: String,
    pub project_path: String,
    #[serde(skip_serializing_if = "OptionalNullable::is_absent")]
    pub executor_id: OptionalNullable<ExecutorId>,
    pub model: String,
    #[serde(flatten)]
    pub routing: CommandRoutingOverrides,
    pub permission_mode: PermissionMode,
    pub thinking_mode: ThinkingMode,
    pub agent_settings: AgentSettingsEnvelope,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<AgentCommandImage>>,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_message_presentation: Option<UserMessagePresentation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ordered_preamble_ids: Option<Vec<PreambleId>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandRoutingOverrides {
    #[serde(skip_serializing_if = "OptionalNullable::is_absent")]
    pub api_provider_id: OptionalNullable<String>,
    #[serde(skip_serializing_if = "OptionalNullable::is_absent")]
    pub model_endpoint_id: OptionalNullable<String>,
    #[serde(skip_serializing_if = "OptionalNullable::is_absent")]
    pub model_protocol: OptionalNullable<ApiProtocol>,
}

impl CommandRoutingOverrides {
    fn is_absent(&self) -> bool {
        self.api_provider_id.is_absent()
            && self.model_endpoint_id.is_absent()
            && self.model_protocol.is_absent()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionFallbackPolicy {
    RequireExplicitBypass,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunCommandRequest {
    pub client_request_id: String,
    pub client_message_id: String,
    pub chat_id: ChatId,
    pub transcript_view_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excluded_resend_ordinals: Option<Vec<u64>>,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<AgentCommandImage>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_mode: Option<ThinkingMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_settings: Option<AgentSettingsEnvelope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(flatten)]
    pub routing: CommandRoutingOverrides,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_agent_ownership_epoch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags_to_add: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_fallback_policy: Option<PermissionFallbackPolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handoff: Option<AgentHandoffRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_message_presentation: Option<UserMessagePresentation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question_reply: Option<AsyncQuestionReply>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHandoffTarget {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executor_id: Option<ExecutorId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    pub agent_id: String,
    pub model: String,
    #[serde(skip_serializing_if = "OptionalNullable::is_absent")]
    pub api_provider_id: OptionalNullable<String>,
    #[serde(skip_serializing_if = "OptionalNullable::is_absent")]
    pub model_endpoint_id: OptionalNullable<String>,
    #[serde(skip_serializing_if = "OptionalNullable::is_absent")]
    pub model_protocol: OptionalNullable<ApiProtocol>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_mode: Option<ThinkingMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_settings: Option<AgentSettingsEnvelope>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHandoffRequest {
    pub target: AgentHandoffTarget,
    pub expected_agent_ownership_epoch: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHandoffCommandRequest {
    pub chat_id: ChatId,
    pub client_request_id: String,
    pub handoff: AgentHandoffRequest,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkRunCommandRequest {
    pub client_request_id: String,
    pub client_message_id: String,
    pub source_chat_id: ChatId,
    pub chat_id: ChatId,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_handoff_fork: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<AgentCommandImage>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_mode: Option<ThinkingMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_settings: Option<AgentSettingsEnvelope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(flatten)]
    pub routing: CommandRoutingOverrides,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntryCreateCommandRequest {
    pub client_request_id: String,
    pub client_message_id: String,
    pub chat_id: ChatId,
    pub transcript_view_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub excluded_resend_ordinals: Option<Vec<u64>>,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<AgentCommandImage>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_agent_ownership_epoch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntryReplaceCommandRequest {
    pub client_request_id: String,
    pub chat_id: ChatId,
    pub entry_id: String,
    pub content: String,
    pub expected_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntryDeleteCommandRequest {
    pub client_request_id: String,
    pub chat_id: ChatId,
    pub entry_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QueueEntryPlacement {
    Before,
    After,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntryMoveCommandRequest {
    pub client_request_id: String,
    pub chat_id: ChatId,
    pub entry_id: String,
    pub target_entry_id: String,
    pub placement: QueueEntryPlacement,
    pub expected_reorder_revision: u64,
    pub expected_source_revision: u64,
    pub expected_target_revision: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SteerUnavailableTurnPolicy {
    Reject,
    Queue,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SteerCommandRequest {
    pub client_request_id: String,
    pub client_message_id: String,
    pub chat_id: ChatId,
    pub transcript_view_id: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question_reply: Option<AsyncQuestionReply>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_agent_ownership_epoch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_message_presentation: Option<UserMessagePresentation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub when_turn_unavailable: Option<SteerUnavailableTurnPolicy>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntrySteerCommandRequest {
    pub client_request_id: String,
    pub chat_id: ChatId,
    pub transcript_view_id: String,
    pub entry_id: String,
    pub expected_revision: u64,
    pub expected_reorder_revision: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueMutationRequest {
    pub chat_id: ChatId,
}

pub type QueuePauseRequest = QueueMutationRequest;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueResumeRequest {
    pub chat_id: ChatId,
    pub pause_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum PermissionDecisionResponse {
    Structured(AskUserQuestionDecisionResponse),
    Provider(Opaque),
}

impl<'de> Deserialize<'de> for PermissionDecisionResponse {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let response = Opaque::deserialize(deserializer)?;
        if !response.is_object() {
            return Err(D::Error::custom("response must be an object"));
        }
        // Executor providers own arbitrary response objects. Only the command
        // parser normalizes an explicitly typed question response.
        Ok(Self::Provider(response))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDecisionPayload {
    pub allow: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub always_allow: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response: Option<PermissionDecisionResponse>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDecisionCommandRequest {
    pub client_request_id: String,
    pub chat_id: ChatId,
    pub permission_occurrence_id: String,
    pub allow: bool,
    pub always_allow: bool,
    pub control: ChatTransientControlAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response: Option<PermissionDecisionResponse>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStopCommandRequest {
    pub client_request_id: String,
    pub chat_id: ChatId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
}

pub type AgentInterruptAndSendCommandRequest = AgentStopCommandRequest;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactCommandRequest {
    pub client_request_id: String,
    pub chat_id: ChatId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionSettingsPatchRequest {
    pub chat_id: ChatId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_agent_ownership_epoch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_mode: Option<ThinkingMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_settings_patch: Option<Opaque>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPatchRequest {
    pub chat_id: ChatId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_agent_ownership_epoch: Option<String>,
    pub model: String,
    #[serde(flatten)]
    pub routing: CommandRoutingOverrides,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPathPatchRequest {
    pub chat_id: ChatId,
    pub project_path: String,
    pub expected_executor_id: ExecutorId,
    pub expected_agent_ownership_epoch: String,
    pub expected_project_path: String,
}

pub fn parse_start_chat_command_request(
    value: &Value,
) -> Result<StartChatCommandRequest, ValidationError> {
    let body = request_record(value)?;
    reject_question_reply(body)?;
    let executor_id = match body.get("executorId") {
        None => OptionalNullable::ABSENT,
        Some(Value::Null) => OptionalNullable::NULL,
        Some(value @ Value::String(id)) if is_executor_id(value) => {
            OptionalNullable::some(id.clone())
        }
        _ => return Err(ValidationError::new("executorId is invalid")),
    };
    if body.contains_key("options") {
        return Err(ValidationError::new("options is not supported"));
    }
    if body.contains_key("parentChat") || body.contains_key("lineage") {
        return Err(ValidationError::new(
            "Storage relationships are not supported; use parentChatId",
        ));
    }
    let origin = match body.get("origin").and_then(Value::as_str) {
        Some("interactive") => ClientChatStartOrigin::Interactive,
        Some("cli") => ClientChatStartOrigin::Cli,
        _ => return Err(ValidationError::new("origin must be interactive or cli")),
    };
    let client_request_id = required_command_correlation_id(body, "clientRequestId")?.to_owned();
    let client_message_id = required_command_correlation_id(body, "clientMessageId")?.to_owned();
    let chat_id = required_chat_id(body, "chatId")?;
    let parent_chat_id = optional_chat_id(body, "parentChatId")?;
    let agent_id = required_string(body, "agentId")?.to_owned();
    let images = optional_images(body.get("images"))?;
    let command = content_or_images(body, "command", images.as_deref())?.to_owned();
    let agent_settings = required_agent_settings(property(body, "agentSettings"), "agentSettings")?;
    let user_message_presentation =
        parse_command_user_message_presentation(body.get("userMessagePresentation"))?;
    let ordered_preamble_ids = optional_ordered_preamble_ids(body.get("orderedPreambleIds"))?;
    if agent_settings.owner_id != agent_id {
        return Err(ValidationError::new(
            "agentSettings must be owned by agentId",
        ));
    }
    Ok(StartChatCommandRequest {
        origin,
        client_request_id,
        client_message_id,
        chat_id,
        parent_chat_id,
        agent_id,
        project_path: required_content(body, "projectPath")?.to_owned(),
        executor_id,
        model: required_string(body, "model")?.to_owned(),
        routing: routing_overrides(body)?,
        permission_mode: normalize_permission_mode(
            property(body, "permissionMode"),
            DEFAULT_PERMISSION_MODE,
        ),
        thinking_mode: normalize_thinking_mode(
            property(body, "thinkingMode"),
            DEFAULT_THINKING_MODE,
        ),
        agent_settings,
        command,
        images,
        tags: normalize_tags(
            body.get("tags")
                .and_then(Value::as_array)
                .map_or(&[], Vec::as_slice),
        ),
        user_message_presentation,
        ordered_preamble_ids,
    })
}

fn optional_ordered_preamble_ids(
    value: Option<&Value>,
) -> Result<Option<Vec<PreambleId>>, ValidationError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let ids = value
        .as_array()
        .ok_or_else(|| ValidationError::new("orderedPreambleIds must be an array"))?;
    if ids.len() > PREAMBLE_MAX_COUNT {
        return Err(ValidationError::new("orderedPreambleIds is too long"));
    }
    let mut seen = HashSet::with_capacity(ids.len());
    let mut result = Vec::with_capacity(ids.len());
    for value in ids {
        let id = value
            .as_str()
            .filter(|_| is_preamble_id(value))
            .ok_or_else(|| {
                ValidationError::new("orderedPreambleIds contains an invalid preamble ID")
            })?;
        if !seen.insert(id) {
            return Err(ValidationError::new(
                "orderedPreambleIds contains a duplicate ID",
            ));
        }
        result.push(id.to_owned());
    }
    Ok(Some(result))
}

pub fn parse_agent_run_command_request(
    value: &Value,
) -> Result<AgentRunCommandRequest, ValidationError> {
    let body = request_record(value)?;
    let question_reply = parse_command_question_reply(body, CommandQuestionReplyField::Command)?;
    let handoff = optional_agent_handoff_request(body.get("handoff"))?;
    let user_message_presentation =
        parse_command_user_message_presentation(body.get("userMessagePresentation"))?;
    let images = optional_images(body.get("images"))?;
    let model = optional_non_empty_string(body, "model")?.map(str::to_owned);
    let routing = routing_overrides(body)?;
    if model.is_none() && !routing.is_absent() {
        return Err(ValidationError::new(
            "model is required with routing overrides",
        ));
    }
    if !routing.model_endpoint_id.is_absent() && routing.api_provider_id.is_absent() {
        return Err(ValidationError::new(
            "apiProviderId is required with modelEndpointId",
        ));
    }
    let permission_mode = optional_permission_mode(body.get("permissionMode"))?;
    let thinking_mode = optional_thinking_mode(body.get("thinkingMode"))?;
    let agent_settings = optional_agent_settings(body.get("agentSettings"), "agentSettings")?;
    if handoff.is_some()
        && (model.is_some()
            || !routing.is_absent()
            || permission_mode.is_some()
            || thinking_mode.is_some()
            || agent_settings.is_some())
    {
        return Err(ValidationError::new(
            "handoff cannot be combined with same-agent execution overrides",
        ));
    }
    let expected_agent_id = optional_non_empty_string(body, "expectedAgentId")?.map(str::to_owned);
    let expected_agent_ownership_epoch =
        optional_non_empty_string(body, "expectedAgentOwnershipEpoch")?.map(str::to_owned);
    let permission_fallback_policy = match body.get("permissionFallbackPolicy") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if value == "require-explicit-bypass" => {
            Some(PermissionFallbackPolicy::RequireExplicitBypass)
        }
        _ => return Err(ValidationError::new("permissionFallbackPolicy is invalid")),
    };
    let tags_to_add = match body.get("tagsToAdd") {
        None | Some(Value::Null) => None,
        Some(Value::Array(tags)) => Some(normalize_tags(tags)),
        _ => return Err(ValidationError::new("tagsToAdd must be an array")),
    };
    Ok(AgentRunCommandRequest {
        client_request_id: required_command_correlation_id(body, "clientRequestId")?.to_owned(),
        client_message_id: required_command_correlation_id(body, "clientMessageId")?.to_owned(),
        chat_id: required_chat_id(body, "chatId")?,
        transcript_view_id: required_string(body, "transcriptViewId")?.to_owned(),
        excluded_resend_ordinals: optional_resend_ordinals(body.get("excludedResendOrdinals"))?,
        command: content_or_images(body, "command", images.as_deref())?.to_owned(),
        images,
        permission_mode,
        thinking_mode,
        agent_settings,
        model,
        routing,
        expected_agent_id,
        expected_agent_ownership_epoch,
        tags_to_add,
        permission_fallback_policy,
        handoff,
        user_message_presentation,
        question_reply,
    })
}

pub fn parse_fork_run_command_request(
    value: &Value,
) -> Result<ForkRunCommandRequest, ValidationError> {
    let body = request_record(value)?;
    reject_question_reply(body)?;
    let images = optional_images(body.get("images"))?;
    let agent_settings = optional_agent_settings(body.get("agentSettings"), "agentSettings")?;
    let model = optional_string(body, "model", true)?.map(str::to_owned);
    let allow_handoff_fork = parse_handoff_fork_consent(body)?;
    Ok(ForkRunCommandRequest {
        client_request_id: required_command_correlation_id(body, "clientRequestId")?.to_owned(),
        client_message_id: required_command_correlation_id(body, "clientMessageId")?.to_owned(),
        source_chat_id: required_chat_id(body, "sourceChatId")?,
        chat_id: required_chat_id(body, "chatId")?,
        command: content_or_images(body, "command", images.as_deref())?.to_owned(),
        allow_handoff_fork,
        images,
        permission_mode: body
            .get("permissionMode")
            .map(|value| normalize_permission_mode(value, DEFAULT_PERMISSION_MODE)),
        thinking_mode: body
            .get("thinkingMode")
            .map(|value| normalize_thinking_mode(value, DEFAULT_THINKING_MODE)),
        agent_settings,
        model,
        routing: routing_overrides(body)?,
    })
}

pub fn parse_queue_entry_create_command_request(
    value: &Value,
) -> Result<QueueEntryCreateCommandRequest, ValidationError> {
    let body = request_record(value)?;
    reject_question_reply(body)?;
    let images = optional_images(body.get("images"))?;
    let content = required_string_content(body, "content")?;
    let expected_model = optional_string(body, "expectedModel", true)?.map(str::to_owned);
    let expected_agent_id = optional_non_empty_string(body, "expectedAgentId")?.map(str::to_owned);
    let expected_agent_ownership_epoch =
        optional_non_empty_string(body, "expectedAgentOwnershipEpoch")?.map(str::to_owned);
    if trim(content).is_empty() && images.as_ref().is_none_or(Vec::is_empty) {
        return Err(ValidationError::new("content or images are required"));
    }
    Ok(QueueEntryCreateCommandRequest {
        client_request_id: required_command_correlation_id(body, "clientRequestId")?.to_owned(),
        client_message_id: required_command_correlation_id(body, "clientMessageId")?.to_owned(),
        chat_id: required_chat_id(body, "chatId")?,
        transcript_view_id: required_string(body, "transcriptViewId")?.to_owned(),
        excluded_resend_ordinals: optional_resend_ordinals(body.get("excludedResendOrdinals"))?,
        content: content.to_owned(),
        images,
        expected_model,
        expected_agent_id,
        expected_agent_ownership_epoch,
    })
}

fn optional_resend_ordinals(value: Option<&Value>) -> Result<Option<Vec<u64>>, ValidationError> {
    let values = match value {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Array(values)) => values,
        _ => {
            return Err(ValidationError::new(
                "excludedResendOrdinals must be an array",
            ));
        }
    };
    let mut ordinals = values
        .iter()
        .map(|value| {
            safe_integer(Some(value), 1).ok_or_else(|| {
                ValidationError::new("excludedResendOrdinals must contain positive integers")
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    ordinals.sort();
    ordinals.dedup();
    Ok((!ordinals.is_empty()).then_some(ordinals))
}

pub fn parse_queue_entry_replace_command_request(
    value: &Value,
) -> Result<QueueEntryReplaceCommandRequest, ValidationError> {
    let body = request_record(value)?;
    reject_question_reply(body)?;
    let expected_revision = expected_entry_revision(body)?;
    Ok(QueueEntryReplaceCommandRequest {
        client_request_id: required_command_correlation_id(body, "clientRequestId")?.to_owned(),
        chat_id: required_chat_id(body, "chatId")?,
        entry_id: required_queue_entry_id(body, "entryId")?.to_owned(),
        content: required_string_content(body, "content")?.to_owned(),
        expected_revision,
    })
}

pub fn parse_queue_entry_delete_command_request(
    value: &Value,
) -> Result<QueueEntryDeleteCommandRequest, ValidationError> {
    let body = request_record(value)?;
    Ok(QueueEntryDeleteCommandRequest {
        client_request_id: required_command_correlation_id(body, "clientRequestId")?.to_owned(),
        chat_id: required_chat_id(body, "chatId")?,
        entry_id: required_queue_entry_id(body, "entryId")?.to_owned(),
    })
}

pub fn parse_queue_entry_move_command_request(
    value: &Value,
) -> Result<QueueEntryMoveCommandRequest, ValidationError> {
    let body = request_record(value)?;
    let entry_id = required_queue_entry_id(body, "entryId")?;
    let target_entry_id = required_queue_entry_id(body, "targetEntryId")?;
    if entry_id == target_entry_id {
        return Err(ValidationError::new(
            "entryId and targetEntryId must differ",
        ));
    }
    let placement = match body.get("placement").and_then(Value::as_str) {
        Some("before") => QueueEntryPlacement::Before,
        Some("after") => QueueEntryPlacement::After,
        _ => return Err(ValidationError::new("placement must be before or after")),
    };
    let expected_reorder_revision = expected_reorder_revision(body)?;
    let revisions_invalid =
        || ValidationError::new("expected source and target revisions must be positive integers");
    let expected_source_revision =
        safe_integer(body.get("expectedSourceRevision"), 1).ok_or_else(revisions_invalid)?;
    let expected_target_revision =
        safe_integer(body.get("expectedTargetRevision"), 1).ok_or_else(revisions_invalid)?;
    Ok(QueueEntryMoveCommandRequest {
        client_request_id: required_command_correlation_id(body, "clientRequestId")?.to_owned(),
        chat_id: required_chat_id(body, "chatId")?,
        entry_id: entry_id.to_owned(),
        target_entry_id: target_entry_id.to_owned(),
        placement,
        expected_reorder_revision,
        expected_source_revision,
        expected_target_revision,
    })
}

pub fn parse_steer_command_request(value: &Value) -> Result<SteerCommandRequest, ValidationError> {
    let body = request_record(value)?;
    let question_reply = parse_command_question_reply(body, CommandQuestionReplyField::Content)?;
    let user_message_presentation =
        parse_command_user_message_presentation(body.get("userMessagePresentation"))?;
    let when_turn_unavailable = match body.get("whenTurnUnavailable") {
        None => None,
        Some(Value::String(value)) if value == "reject" => Some(SteerUnavailableTurnPolicy::Reject),
        Some(Value::String(value)) if value == "queue" => Some(SteerUnavailableTurnPolicy::Queue),
        _ => {
            return Err(ValidationError::new(
                "whenTurnUnavailable must be reject or queue",
            ));
        }
    };
    if when_turn_unavailable == Some(SteerUnavailableTurnPolicy::Queue)
        && user_message_presentation.is_some()
    {
        return Err(ValidationError::new(
            "A steer that may be queued cannot set userMessagePresentation",
        ));
    }
    Ok(SteerCommandRequest {
        client_request_id: required_command_correlation_id(body, "clientRequestId")?.to_owned(),
        client_message_id: required_command_correlation_id(body, "clientMessageId")?.to_owned(),
        chat_id: required_chat_id(body, "chatId")?,
        transcript_view_id: required_string(body, "transcriptViewId")?.to_owned(),
        content: required_content(body, "content")?.to_owned(),
        question_reply,
        expected_agent_id: optional_non_empty_string(body, "expectedAgentId")?.map(str::to_owned),
        expected_agent_ownership_epoch: optional_non_empty_string(
            body,
            "expectedAgentOwnershipEpoch",
        )?
        .map(str::to_owned),
        user_message_presentation,
        when_turn_unavailable,
    })
}

pub fn parse_queue_entry_steer_command_request(
    value: &Value,
) -> Result<QueueEntrySteerCommandRequest, ValidationError> {
    let body = request_record(value)?;
    reject_question_reply(body)?;
    let expected_revision = expected_entry_revision(body)?;
    let expected_reorder_revision = expected_reorder_revision(body)?;
    Ok(QueueEntrySteerCommandRequest {
        client_request_id: required_command_correlation_id(body, "clientRequestId")?.to_owned(),
        chat_id: required_chat_id(body, "chatId")?,
        transcript_view_id: required_string(body, "transcriptViewId")?.to_owned(),
        entry_id: required_queue_entry_id(body, "entryId")?.to_owned(),
        expected_revision,
        expected_reorder_revision,
    })
}

pub fn parse_queue_mutation_request(
    value: &Value,
) -> Result<QueueMutationRequest, ValidationError> {
    Ok(QueueMutationRequest {
        chat_id: required_chat_id(request_record(value)?, "chatId")?,
    })
}

pub fn parse_queue_resume_request(value: &Value) -> Result<QueueResumeRequest, ValidationError> {
    let body = request_record(value)?;
    Ok(QueueResumeRequest {
        chat_id: required_chat_id(body, "chatId")?,
        pause_id: required_string(body, "pauseId")?.to_owned(),
    })
}

pub fn parse_permission_decision_command_request(
    value: &Value,
) -> Result<PermissionDecisionCommandRequest, ValidationError> {
    let body = request_record(value)?;
    let allow = property(body, "allow")
        .as_bool()
        .ok_or_else(|| ValidationError::new("allow must be a boolean"))?;
    let always_allow = property(body, "alwaysAllow")
        .as_bool()
        .ok_or_else(|| ValidationError::new("alwaysAllow must be a boolean"))?;
    let raw_response = property(body, "response");
    let response = match optional_record(raw_response, "response")? {
        None => None,
        Some(record) if property(record, "type") == "ask-user-question-response" => {
            Some(PermissionDecisionResponse::Structured(
                normalize_ask_user_question_decision_response(raw_response).ok_or_else(|| {
                    ValidationError::new("response contains an invalid structured answer")
                })?,
            ))
        }
        Some(_) => Some(PermissionDecisionResponse::Provider(Opaque::from_value(
            raw_response.clone(),
        ))),
    };
    let control = parse_chat_transient_control_action(property(body, "control"))
        .ok_or_else(|| ValidationError::new("control is invalid"))?;
    let chat_id = required_chat_id(body, "chatId")?;
    let permission_occurrence_id = required_string(body, "permissionOccurrenceId")?;
    if control.chat_id != chat_id.as_str()
        || control.permission_occurrence_id != permission_occurrence_id
    {
        return Err(ValidationError::new(
            "control does not match the permission request",
        ));
    }
    Ok(PermissionDecisionCommandRequest {
        client_request_id: required_command_correlation_id(body, "clientRequestId")?.to_owned(),
        chat_id,
        permission_occurrence_id: permission_occurrence_id.to_owned(),
        allow,
        always_allow,
        control,
        response,
    })
}

pub fn parse_agent_stop_command_request(
    value: &Value,
) -> Result<AgentStopCommandRequest, ValidationError> {
    let body = request_record(value)?;
    let agent_id = optional_string(body, "agentId", true)?.map(str::to_owned);
    Ok(AgentStopCommandRequest {
        client_request_id: required_command_correlation_id(body, "clientRequestId")?.to_owned(),
        chat_id: required_chat_id(body, "chatId")?,
        agent_id,
    })
}

pub fn parse_agent_interrupt_and_send_command_request(
    value: &Value,
) -> Result<AgentInterruptAndSendCommandRequest, ValidationError> {
    parse_agent_stop_command_request(value)
}

pub fn parse_compact_command_request(
    value: &Value,
) -> Result<CompactCommandRequest, ValidationError> {
    let body = request_record(value)?;
    let instructions = optional_string(body, "instructions", false)?.map(str::to_owned);
    Ok(CompactCommandRequest {
        client_request_id: required_command_correlation_id(body, "clientRequestId")?.to_owned(),
        chat_id: required_chat_id(body, "chatId")?,
        instructions,
    })
}

pub fn parse_project_path_patch_request(
    value: &Value,
) -> Result<ProjectPathPatchRequest, ValidationError> {
    let body = request_record(value)?;
    let expected_executor_id = required_string(body, "expectedExecutorId")?.to_owned();
    if !is_executor_id(&Value::String(expected_executor_id.clone())) {
        return Err(ValidationError::new("expectedExecutorId is invalid"));
    }
    Ok(ProjectPathPatchRequest {
        chat_id: required_chat_id(body, "chatId")?,
        project_path: required_content(body, "projectPath")?.to_owned(),
        expected_executor_id,
        expected_agent_ownership_epoch: required_string(body, "expectedAgentOwnershipEpoch")?
            .to_owned(),
        expected_project_path: required_content(body, "expectedProjectPath")?.to_owned(),
    })
}

fn routing_overrides(
    body: &Map<String, Value>,
) -> Result<CommandRoutingOverrides, ValidationError> {
    Ok(CommandRoutingOverrides {
        api_provider_id: nullable_string(body, "apiProviderId")?,
        model_endpoint_id: nullable_string(body, "modelEndpointId")?,
        model_protocol: optional_api_protocol(body.get("modelProtocol"))?,
    })
}

fn property<'a>(body: &'a Map<String, Value>, name: &str) -> &'a Value {
    body.get(name).unwrap_or(&Value::Null)
}

pub(crate) fn safe_integer(value: Option<&Value>, min: u64) -> Option<u64> {
    let number = value.and_then(as_number)?;
    (is_safe_integer(number) && number >= min as f64).then_some(number as u64)
}

fn expected_entry_revision(body: &Map<String, Value>) -> Result<u64, ValidationError> {
    safe_integer(body.get("expectedRevision"), 1)
        .ok_or_else(|| ValidationError::new("expectedRevision must be a positive integer"))
}

fn expected_reorder_revision(body: &Map<String, Value>) -> Result<u64, ValidationError> {
    safe_integer(body.get("expectedReorderRevision"), 0).ok_or_else(|| {
        ValidationError::new("expectedReorderRevision must be a non-negative integer")
    })
}

fn content_or_images<'a>(
    body: &'a Map<String, Value>,
    field: &str,
    images: Option<&[AgentCommandImage]>,
) -> Result<&'a str, ValidationError> {
    let content = property(body, field).as_str().unwrap_or_default();
    if trim(content).is_empty() && images.is_none_or(<[AgentCommandImage]>::is_empty) {
        return Err(ValidationError::new(format!(
            "{field} or images are required"
        )));
    }
    Ok(content)
}

fn optional_images(
    value: Option<&Value>,
) -> Result<Option<Vec<AgentCommandImage>>, ValidationError> {
    let entries = match value {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Array(entries)) => entries,
        _ => return Err(ValidationError::new("images must be an array")),
    };
    entries
        .iter()
        .map(|entry| {
            let image = entry
                .as_object()
                .ok_or_else(|| ValidationError::new("images must contain attachment objects"))?;
            let data = property(image, "data")
                .as_str()
                .filter(|text| !text.is_empty())
                .ok_or_else(|| ValidationError::new("attachment data is required"))?
                .to_owned();
            let field = |name| {
                image
                    .get(name)
                    .map(|value| {
                        value.as_str().map(str::to_owned).ok_or_else(|| {
                            ValidationError::new(format!("attachment {name} must be a string"))
                        })
                    })
                    .transpose()
            };
            Ok(AgentCommandImage {
                data,
                name: field("name")?,
                mime_type: field("mimeType")?,
            })
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn wire(value: &impl Serialize) -> Value {
        garcon_js::json::parse(&serde_json::to_string(value).unwrap()).unwrap()
    }

    #[test]
    fn normalizes_start_modes_and_tags_without_rewriting_the_prompt_or_path() {
        let request = parse_start_chat_command_request(&json!({
            "origin":"interactive","clientRequestId":" request ","clientMessageId":" message ",
            "chatId":"1783725900000000","agentId":"codex","projectPath":" /work ",
            "model":" fixture-model ","agentSettings":{"ownerId":"codex","schemaVersion":1,"values":{}},
            "permissionMode":"invalid","thinkingMode":"invalid","command":" hello ",
            "tags":["Review Needed"," review-needed ","QA"],"orderedPreambleIds":[],
        })).unwrap();
        assert_eq!(request.client_request_id, "request");
        assert_eq!(request.project_path, " /work ");
        assert_eq!(request.command, " hello ");
        assert_eq!(request.tags, ["qa", "review-needed"]);
        assert_eq!(request.permission_mode, DEFAULT_PERMISSION_MODE);
        assert_eq!(request.thinking_mode, DEFAULT_THINKING_MODE);
        assert_eq!(wire(&request)["orderedPreambleIds"], json!([]));
        assert!(wire(&request).get("executorId").is_none());
    }

    #[test]
    fn requires_the_model_and_preserves_explicit_null_routing_overrides() {
        let mut input = json!({
            "clientRequestId":"request","clientMessageId":"message","chatId":"1783725900000000",
            "transcriptViewId":"view","command":"fixture","modelEndpointId":null,
        });
        assert_eq!(
            parse_agent_run_command_request(&input).unwrap_err().message,
            "model is required with routing overrides"
        );
        input["model"] = json!("fixture");
        assert_eq!(
            parse_agent_run_command_request(&input).unwrap_err().message,
            "apiProviderId is required with modelEndpointId"
        );
        input["apiProviderId"] = Value::Null;
        let request = wire(&parse_agent_run_command_request(&input).unwrap());
        assert!(request["apiProviderId"].is_null());
        assert!(request["modelEndpointId"].is_null());
        assert!(request.get("modelProtocol").is_none());
    }

    #[test]
    fn checks_queue_revisions_before_identity_and_keeps_blank_replacement_text() {
        let mut input = json!({"clientRequestId":false,"expectedRevision":0});
        assert_eq!(
            parse_queue_entry_replace_command_request(&input)
                .unwrap_err()
                .message,
            "expectedRevision must be a positive integer"
        );
        input["expectedRevision"] = json!(1);
        assert_eq!(
            parse_queue_entry_replace_command_request(&input)
                .unwrap_err()
                .message,
            "clientRequestId is required"
        );
        input["clientRequestId"] = json!("request");
        input["chatId"] = json!("1783725900000000");
        input["entryId"] = json!("entry");
        input["content"] = json!("");
        assert_eq!(
            parse_queue_entry_replace_command_request(&input)
                .unwrap()
                .content,
            ""
        );
    }

    #[test]
    fn keeps_permission_target_mismatch_ahead_of_request_id_errors() {
        let input = json!({
            "chatId":"1783725900000000","permissionOccurrenceId":"intended","allow":false,"alwaysAllow":false,
            "control":{"serverInstanceId":"instance","chatId":"1783725900000000","runId":"run","permissionOccurrenceId":"different"}
        });
        assert_eq!(
            parse_permission_decision_command_request(&input)
                .unwrap_err()
                .message,
            "control does not match the permission request"
        );
    }
}
