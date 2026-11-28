//! Ports `common/chat-snapshot.ts`.

use garcon_js::{
    OptionalNullable, clock::to_iso_string, date_parse::date_parse, is_safe_integer,
    json::as_number,
};
use serde::Serialize;
use serde_json::Value;

use crate::api_providers::ApiProtocol;
use crate::async_user_questions::InvalidAsyncQuestionReply;
use crate::chat_activity::{ChatActivityStatus, is_chat_activity_status};
use crate::chat_execution_control::{
    ChatExecutionControlState, parse_chat_execution_control_state,
};
use crate::chat_id::{ChatId, parse_chat_id};
use crate::chat_modes::{PermissionMode, ThinkingMode, is_permission_mode, is_thinking_mode};
use crate::chat_transient_feed::{ChatTransientFeedSnapshot, parse_chat_transient_feed_snapshot};
use crate::chat_types::ChatProcessingPhase;
use crate::chat_view::{
    TranscriptPage, TranscriptPageRelations, is_relationally_valid_bounded_transcript_page,
    is_relationally_valid_newest_transcript_page, parse_transcript_messages,
    valid_history_error_code,
};
use crate::executors::{ExecutorId, is_executor_id};
use crate::tags::normalize_tags;

pub const CHAT_SNAPSHOT_DEFAULT_MESSAGE_LIMIT: u64 = 10;
pub const CHAT_SNAPSHOT_MAX_MESSAGE_LIMIT: u64 = 200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSnapshotChat {
    pub id: ChatId,
    #[serde(skip_serializing_if = "OptionalNullable::is_absent")]
    pub executor_id: OptionalNullable<ExecutorId>,
    pub title: String,
    pub activity_status: Option<ChatActivityStatus>,
    pub agent_id: String,
    pub agent_ownership_epoch: String,
    pub carry_over_revision: String,
    pub model: Option<String>,
    pub api_provider_id: Option<String>,
    pub model_endpoint_id: Option<String>,
    pub model_protocol: Option<ApiProtocol>,
    pub permission_mode: PermissionMode,
    pub thinking_mode: ThinkingMode,
    pub project_path: String,
    pub tags: Vec<String>,
    pub can_reload_from_native_history: bool,
    pub activity: ChatSnapshotActivity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSnapshotActivity {
    pub created_at: Option<String>,
    pub last_activity_at: Option<String>,
}

pub type AvailableChatSnapshotTranscript = TranscriptPage;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnavailableChatSnapshotTranscript {
    pub error_code: String,
    pub retryable: bool,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "availability", rename_all = "kebab-case")]
pub enum ChatSnapshotTranscript {
    Available(AvailableChatSnapshotTranscript),
    Unavailable(UnavailableChatSnapshotTranscript),
    NotRequested,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSnapshotResponse {
    pub observed_at: String,
    pub message_limit: u64,
    pub chat: ChatSnapshotChat,
    pub processing_phase: Option<ChatProcessingPhase>,
    pub control: ChatExecutionControlState,
    pub transient_feed: ChatTransientFeedSnapshot,
    pub transcript: ChatSnapshotTranscript,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ChatSnapshotContractError {
    #[error("{0}")]
    Field(String),
    #[error(transparent)]
    Message(#[from] InvalidAsyncQuestionReply),
}

impl ChatSnapshotContractError {
    pub fn new(message: impl Into<String>) -> Self {
        Self::Field(message.into())
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::Field(_) => "ChatSnapshotContractError",
            Self::Message(_) => "TypeError",
        }
    }
}

pub fn parse_chat_snapshot_response(
    value: &Value,
) -> Result<ChatSnapshotResponse, ChatSnapshotContractError> {
    require_record(value, "chat snapshot")?;
    let observed_at = canonical_timestamp(&value["observedAt"], "observedAt")?;
    let message_limit = nonnegative_integer(&value["messageLimit"], "messageLimit")?;
    if message_limit > CHAT_SNAPSHOT_MAX_MESSAGE_LIMIT {
        return Err(fail("messageLimit exceeds its maximum"));
    }
    let chat = parse_chat(&value["chat"])?;
    let processing_phase = match value.get("processingPhase") {
        Some(Value::Null) => None,
        Some(phase) if phase == "running" => Some(ChatProcessingPhase::Running),
        Some(phase) if phase == "stopping" => Some(ChatProcessingPhase::Stopping),
        Some(phase) if phase == "reconnecting" => Some(ChatProcessingPhase::Reconnecting),
        _ => return Err(fail("processingPhase is invalid")),
    };
    let control = parse_chat_execution_control_state(&value["control"])
        .ok_or_else(|| fail("control is invalid"))?;
    let transient_feed = parse_chat_transient_feed_snapshot(&value["transientFeed"])?
        .ok_or_else(|| fail("transientFeed is invalid"))?;
    if transient_feed.chat_id != chat.id.as_str() {
        return Err(fail("transientFeed belongs to another chat"));
    }
    let transcript = parse_transcript(&value["transcript"], message_limit)?;
    if let ChatSnapshotTranscript::Available(page) = &transcript
        && page.transcript_view_id != transient_feed.transcript_view_id
    {
        return Err(fail("transientFeed and transcript views differ"));
    }
    Ok(ChatSnapshotResponse {
        observed_at,
        message_limit,
        chat,
        processing_phase,
        control,
        transient_feed,
        transcript,
    })
}

fn parse_chat(value: &Value) -> Result<ChatSnapshotChat, ChatSnapshotContractError> {
    require_record(value, "chat")?;
    let id = parse_chat_id(&value["id"]).map_err(|_| fail("chat.id is invalid"))?;
    let permission_mode = is_permission_mode(&value["permissionMode"])
        .ok_or_else(|| fail("chat.permissionMode is invalid"))?;
    let thinking_mode = is_thinking_mode(&value["thinkingMode"])
        .ok_or_else(|| fail("chat.thinkingMode is invalid"))?;
    let raw_tags = value["tags"]
        .as_array()
        .filter(|tags| tags.iter().all(Value::is_string))
        .ok_or_else(|| fail("chat.tags must be a string array"))?;
    let tags = normalize_tags(raw_tags);
    if tags.len() != raw_tags.len()
        || tags
            .iter()
            .zip(raw_tags)
            .any(|(tag, raw)| raw != tag.as_str())
    {
        return Err(fail("chat.tags must be normalized, unique, and sorted"));
    }
    let activity = &value["activity"];
    require_record(activity, "chat.activity")?;
    let activity_status = match value.get("activityStatus") {
        Some(Value::Null) => None,
        Some(status) => Some(
            is_chat_activity_status(status)
                .ok_or_else(|| fail("chat.activityStatus is invalid"))?,
        ),
        None => return Err(fail("chat.activityStatus is invalid")),
    };
    let executor_id = match value.get("executorId") {
        None => OptionalNullable::ABSENT,
        Some(Value::Null) => OptionalNullable::NULL,
        Some(id) if is_executor_id(id) => {
            OptionalNullable::some(id.as_str().unwrap_or_default().to_owned())
        }
        Some(_) => return Err(fail("chat.executorId is invalid")),
    };
    Ok(ChatSnapshotChat {
        id,
        executor_id,
        title: required_string(&value["title"], "chat.title")?,
        activity_status,
        agent_id: required_string(&value["agentId"], "chat.agentId")?,
        agent_ownership_epoch: required_string(
            &value["agentOwnershipEpoch"],
            "chat.agentOwnershipEpoch",
        )?,
        carry_over_revision: required_string(
            &value["carryOverRevision"],
            "chat.carryOverRevision",
        )?,
        model: nullable(value.get("model"), "chat.model", required_string)?,
        api_provider_id: nullable(
            value.get("apiProviderId"),
            "chat.apiProviderId",
            required_string,
        )?,
        model_endpoint_id: nullable(
            value.get("modelEndpointId"),
            "chat.modelEndpointId",
            required_string,
        )?,
        model_protocol: nullable(
            value.get("modelProtocol"),
            "chat.modelProtocol",
            |value, field| match value.as_str() {
                Some("anthropic-messages") => Ok(ApiProtocol::AnthropicMessages),
                Some("openai-compatible") => Ok(ApiProtocol::OpenAiCompatible),
                _ => Err(invalid(field)),
            },
        )?,
        permission_mode,
        thinking_mode,
        project_path: required_string(&value["projectPath"], "chat.projectPath")?,
        tags,
        can_reload_from_native_history: value["canReloadFromNativeHistory"]
            .as_bool()
            .ok_or_else(|| invalid("chat.canReloadFromNativeHistory"))?,
        activity: ChatSnapshotActivity {
            created_at: nullable(
                activity.get("createdAt"),
                "chat.activity.createdAt",
                canonical_timestamp,
            )?,
            last_activity_at: nullable(
                activity.get("lastActivityAt"),
                "chat.activity.lastActivityAt",
                canonical_timestamp,
            )?,
        },
    })
}

fn parse_transcript(
    value: &Value,
    message_limit: u64,
) -> Result<ChatSnapshotTranscript, ChatSnapshotContractError> {
    require_record(value, "transcript")?;
    let availability = value["availability"].as_str();
    if message_limit == 0 {
        return if availability == Some("not-requested") {
            Ok(ChatSnapshotTranscript::NotRequested)
        } else {
            Err(fail(
                "transcript must be not-requested when messageLimit is zero",
            ))
        };
    }
    match availability {
        Some("not-requested") => {
            return Err(fail(
                "transcript cannot be not-requested when messages were requested",
            ));
        }
        Some("unavailable") => {
            let error_code = value["errorCode"]
                .as_str()
                .filter(|code| valid_history_error_code(code))
                .ok_or_else(|| invalid("transcript.errorCode"))?;
            let retryable = value["retryable"]
                .as_bool()
                .ok_or_else(|| invalid("transcript.retryable"))?;
            return Ok(ChatSnapshotTranscript::Unavailable(
                UnavailableChatSnapshotTranscript {
                    error_code: error_code.to_owned(),
                    retryable,
                    message: required_string(&value["message"], "transcript.message")?,
                },
            ));
        }
        Some("available") => {}
        _ => return Err(invalid("transcript.availability")),
    }
    let messages = parse_transcript_messages(&value["messages"])?
        .filter(|messages| messages.len() as u64 <= message_limit)
        .ok_or_else(|| invalid("transcript.messages"))?;
    let last_ordinal = nonnegative_integer(&value["lastOrdinal"], "transcript.lastOrdinal")?;
    let page_oldest_ordinal =
        nonnegative_integer(&value["pageOldestOrdinal"], "transcript.pageOldestOrdinal")?;
    let page_newest_ordinal =
        nonnegative_integer(&value["pageNewestOrdinal"], "transcript.pageNewestOrdinal")?;
    let next_before_ordinal = nullable(
        value.get("nextBeforeOrdinal"),
        "transcript.nextBeforeOrdinal",
        |value, field| {
            let ordinal = nonnegative_integer(value, field)?;
            (ordinal > 1)
                .then_some(ordinal)
                .ok_or_else(|| fail(format!("{field} must be greater than one")))
        },
    )?;
    let has_more = value["hasMore"]
        .as_bool()
        .ok_or_else(|| invalid("transcript.hasMore"))?;
    let relations = TranscriptPageRelations {
        messages: &messages,
        last_ordinal: last_ordinal as f64,
        page_oldest_ordinal: page_oldest_ordinal as f64,
        page_newest_ordinal: page_newest_ordinal as f64,
        next_before_ordinal: next_before_ordinal.map(|cursor| cursor as f64),
        has_more,
    };
    if !is_relationally_valid_newest_transcript_page(relations)
        || !is_relationally_valid_bounded_transcript_page(relations, message_limit as f64)
    {
        return Err(fail("transcript ordinal metadata is inconsistent"));
    }
    Ok(ChatSnapshotTranscript::Available(TranscriptPage {
        transcript_view_id: required_string(
            &value["transcriptViewId"],
            "transcript.transcriptViewId",
        )?,
        messages,
        last_ordinal,
        page_oldest_ordinal,
        page_newest_ordinal,
        next_before_ordinal,
        has_more,
    }))
}

fn nullable<T>(
    value: Option<&Value>,
    field: &str,
    parse: impl FnOnce(&Value, &str) -> Result<T, ChatSnapshotContractError>,
) -> Result<Option<T>, ChatSnapshotContractError> {
    match value {
        Some(Value::Null) => Ok(None),
        Some(value) => parse(value, field).map(Some),
        None => parse(&Value::Null, field).map(Some),
    }
}

fn canonical_timestamp(value: &Value, field: &str) -> Result<String, ChatSnapshotContractError> {
    let text = value.as_str().ok_or_else(|| invalid(field))?;
    let parsed = date_parse(text).and_then(|millis| to_iso_string(millis).ok());
    if parsed.as_deref() != Some(text) {
        return Err(invalid(field));
    }
    Ok(text.to_owned())
}

fn nonnegative_integer(value: &Value, field: &str) -> Result<u64, ChatSnapshotContractError> {
    as_number(value)
        .filter(|&n| is_safe_integer(n) && n >= 0.0)
        .map(|n| n as u64)
        .ok_or_else(|| fail(format!("{field} must be a non-negative integer")))
}

fn required_string(value: &Value, field: &str) -> Result<String, ChatSnapshotContractError> {
    value
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| invalid(field))
}

fn require_record(value: &Value, field: &str) -> Result<(), ChatSnapshotContractError> {
    if value.is_object() {
        Ok(())
    } else {
        Err(fail(format!("{field} must be an object")))
    }
}

fn invalid(field: &str) -> ChatSnapshotContractError {
    fail(format!("{field} is invalid"))
}

fn fail(message: impl Into<String>) -> ChatSnapshotContractError {
    ChatSnapshotContractError::new(message)
}
