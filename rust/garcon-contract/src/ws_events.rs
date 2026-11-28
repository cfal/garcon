//! Session-level events from common/ws-events.ts.
//!
//! Deferred with chat-view: ServerWsMessage, EventKey, parseServerWsMessage,
//! ChatMessagesMessage, ChatSubscribedMessage, ChatTranscriptReplacedMessage,
//! ChatTransientFeedMutationMessage, CHAT_RELOAD_PHASES, ChatReloadPhase,
//! ChatReloadProgress, ChatReloadProgressMessage, ChatReloadedMessage,
//! AgentRunFinishedOutcome, AgentRunFinishedMessage, AgentRunFailedMessage,
//! ChatSessionCreatedMessage, ChatProjectPathUpdatedMessage,
//! ChatProjectPathUpdatedPayload, ChatSessionStoppedMessage,
//! ChatProcessingUpdatedMessage, ChatActivityUpdatedMessage,
//! ChatExecutionControlUpdatedMessage, ChatOperationalNoticeType,
//! ChatOperationalNoticeDetail, ChatOperationalNoticeMessage,
//! ChatTitleUpdatedMessage, ChatSessionDeletedWsMessage, ChatReadUpdatedV1Message,
//! CHAT_LIST_INVALIDATION_REASONS, ChatListInvalidationReason,
//! isChatListInvalidationReason, ChatListRefreshRequestedMessage,
//! ChatBoardsInvalidatedMessage, SettingsChangedMessage, ApiProvidersInvalidatedMessage,
//! ExecutorsChangedMessage, TranscriptSearchStatusMessage, ScheduledPromptsInvalidatedMessage,
//! SnippetsInvalidatedMessage, PreamblesInvalidatedMessage, ChatPreamblesInvalidatedMessage.

use std::collections::HashSet;

use garcon_js::Number;
use serde::{Deserialize, Serialize, Serializer, ser::SerializeStruct};
use serde_json::Value;

use crate::chat_execution_control::{
    ChatExecutionControlState, parse_chat_execution_control_state,
    parse_execution_control_server_instance_id,
};
use crate::chat_types::{ChatProcessingEntry, ChatProcessingPhase};
use crate::ws_value_parsing::{required_str, str};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReconnectControlResult {
    Snapshot {
        chat_id: String,
        control: Box<ChatExecutionControlState>,
    },
    NotFound {
        chat_id: String,
    },
    Unavailable {
        chat_id: String,
    },
}

impl Serialize for ReconnectControlResult {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let (chat_id, outcome, control) = match self {
            Self::Snapshot { chat_id, control } => (chat_id, "snapshot", Some(control)),
            Self::NotFound { chat_id } => (chat_id, "not-found", None),
            Self::Unavailable { chat_id } => (chat_id, "unavailable", None),
        };
        let mut record = serializer.serialize_struct(
            "ReconnectControlResult",
            if control.is_some() { 3 } else { 2 },
        )?;
        record.serialize_field("chatId", chat_id)?;
        record.serialize_field("outcome", outcome)?;
        if let Some(control) = control {
            record.serialize_field("control", control)?;
        }
        record.end()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "kebab-case")]
pub enum ChatProcessingSnapshotResult {
    Snapshot { chats: Vec<ChatProcessingEntry> },
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconnectStateMessage {
    pub processing: ChatProcessingSnapshotResult,
    pub control_results: Vec<ReconnectControlResult>,
    pub server_instance_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_request_id: Option<String>,
    #[serde(rename = "type")]
    message_type: &'static str,
}

impl ReconnectStateMessage {
    pub const TYPE: &'static str = "reconnect-state";

    pub fn new(
        processing: ChatProcessingSnapshotResult,
        control_results: Vec<ReconnectControlResult>,
        server_instance_id: String,
        client_request_id: Option<String>,
    ) -> Self {
        Self {
            processing,
            control_results,
            server_instance_id,
            client_request_id,
            message_type: Self::TYPE,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WsFaultMessage {
    pub error: String,
    #[serde(rename = "type")]
    message_type: &'static str,
}

impl WsFaultMessage {
    pub const TYPE: &'static str = "ws-fault";

    pub fn new(error: String) -> Self {
        Self {
            error,
            message_type: Self::TYPE,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WsPongMessage {
    pub client_request_id: String,
    pub sent_at: Number,
    pub server_time: String,
    pub processing: ChatProcessingSnapshotResult,
    pub server_instance_id: String,
    #[serde(rename = "type")]
    message_type: &'static str,
}

impl WsPongMessage {
    pub const TYPE: &'static str = "ws-pong";

    pub fn new(
        client_request_id: String,
        sent_at: Number,
        server_time: String,
        processing: ChatProcessingSnapshotResult,
        server_instance_id: String,
    ) -> Self {
        Self {
            client_request_id,
            sent_at,
            server_time,
            processing,
            server_instance_id,
            message_type: Self::TYPE,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ClientRequestErrorCode {
    MissingChatId,
    RequestValidationFailed,
    SessionNotFound,
    ChatRunning,
    NativePathUnresolved,
    HistoryLoadFailed,
    StaleTranscriptView,
    RequestTimeout,
    RequestCancelled,
    InternalError,
}

fn client_request_error_code(value: &Value) -> Option<ClientRequestErrorCode> {
    use ClientRequestErrorCode as Code;
    Some(match value.as_str()? {
        "MISSING_CHAT_ID" => Code::MissingChatId,
        "REQUEST_VALIDATION_FAILED" => Code::RequestValidationFailed,
        "SESSION_NOT_FOUND" => Code::SessionNotFound,
        "CHAT_RUNNING" => Code::ChatRunning,
        "NATIVE_PATH_UNRESOLVED" => Code::NativePathUnresolved,
        "HISTORY_LOAD_FAILED" => Code::HistoryLoadFailed,
        "STALE_TRANSCRIPT_VIEW" => Code::StaleTranscriptView,
        "REQUEST_TIMEOUT" => Code::RequestTimeout,
        "REQUEST_CANCELLED" => Code::RequestCancelled,
        "INTERNAL_ERROR" => Code::InternalError,
        _ => return None,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientRequestErrorMessage {
    pub client_request_id: String,
    pub request_type: String,
    pub code: ClientRequestErrorCode,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<String>,
    #[serde(rename = "type")]
    message_type: &'static str,
}

impl ClientRequestErrorMessage {
    pub const TYPE: &'static str = "client-request-error";

    pub fn new(
        client_request_id: String,
        request_type: String,
        code: ClientRequestErrorCode,
        message: String,
        retryable: bool,
        chat_id: Option<String>,
    ) -> Self {
        Self {
            client_request_id,
            request_type,
            code,
            message,
            retryable,
            chat_id,
            message_type: Self::TYPE,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum SessionWsMessage {
    ReconnectState(ReconnectStateMessage),
    WsFault(WsFaultMessage),
    WsPong(WsPongMessage),
    ClientRequestError(ClientRequestErrorMessage),
}

fn reconnect_control_results(value: &Value) -> Option<Vec<ReconnectControlResult>> {
    let values = value.as_array()?;
    let mut results = Vec::with_capacity(values.len());
    let mut seen = HashSet::new();
    for result in values {
        let chat_id = required_str(&result["chatId"])?;
        if !seen.insert(chat_id) {
            return None;
        }
        results.push(match result["outcome"].as_str()? {
            "snapshot" => ReconnectControlResult::Snapshot {
                chat_id: chat_id.to_owned(),
                control: Box::new(parse_chat_execution_control_state(&result["control"])?),
            },
            "not-found" => ReconnectControlResult::NotFound {
                chat_id: chat_id.to_owned(),
            },
            "unavailable" => ReconnectControlResult::Unavailable {
                chat_id: chat_id.to_owned(),
            },
            _ => return None,
        });
    }
    Some(results)
}

fn chat_processing_snapshot_result(value: &Value) -> Option<ChatProcessingSnapshotResult> {
    match value["outcome"].as_str()? {
        "unavailable" => Some(ChatProcessingSnapshotResult::Unavailable),
        "snapshot" => {
            let entries = value["chats"].as_array()?;
            let mut chats = Vec::with_capacity(entries.len());
            let mut seen = HashSet::new();
            for entry in entries {
                let chat_id = required_str(&entry["chatId"])?;
                let phase = match entry["phase"].as_str()? {
                    "running" => ChatProcessingPhase::Running,
                    "stopping" => ChatProcessingPhase::Stopping,
                    "reconnecting" => ChatProcessingPhase::Reconnecting,
                    _ => return None,
                };
                if !seen.insert(chat_id) {
                    return None;
                }
                chats.push(ChatProcessingEntry {
                    chat_id: chat_id.to_owned(),
                    phase,
                });
            }
            Some(ChatProcessingSnapshotResult::Snapshot { chats })
        }
        _ => None,
    }
}

pub fn parse_session_ws_message(data: &Value) -> Option<SessionWsMessage> {
    Some(match data["type"].as_str()? {
        ReconnectStateMessage::TYPE => {
            let processing = chat_processing_snapshot_result(&data["processing"])?;
            let control_results = reconnect_control_results(&data["controlResults"])?;
            let server_instance_id =
                parse_execution_control_server_instance_id(&data["serverInstanceId"])?;
            if control_results.iter().any(|result| {
                matches!(result, ReconnectControlResult::Snapshot { control, .. }
                    if control.server_instance_id != server_instance_id)
            }) {
                return None;
            }
            SessionWsMessage::ReconnectState(ReconnectStateMessage::new(
                processing,
                control_results,
                server_instance_id.to_owned(),
                data["clientRequestId"].as_str().map(str::to_owned),
            ))
        }
        WsFaultMessage::TYPE => {
            SessionWsMessage::WsFault(WsFaultMessage::new(str(&data["error"]).to_owned()))
        }
        WsPongMessage::TYPE => {
            let client_request_id = required_str(&data["clientRequestId"])?;
            let sent_at = data["sentAt"].as_f64().filter(|value| value.is_finite())?;
            let server_time = required_str(&data["serverTime"])?;
            let processing = chat_processing_snapshot_result(&data["processing"])?;
            let server_instance_id =
                parse_execution_control_server_instance_id(&data["serverInstanceId"])?;
            SessionWsMessage::WsPong(WsPongMessage::new(
                client_request_id.to_owned(),
                Number(sent_at),
                server_time.to_owned(),
                processing,
                server_instance_id.to_owned(),
            ))
        }
        ClientRequestErrorMessage::TYPE => {
            let client_request_id = required_str(&data["clientRequestId"])?;
            let request_type = required_str(&data["requestType"])?;
            let code = client_request_error_code(&data["code"])?;
            let message = data["message"].as_str()?;
            let retryable = data["retryable"].as_bool()?;
            let chat_id = match data.get("chatId") {
                Some(chat_id) => Some(required_str(chat_id)?.to_owned()),
                None => None,
            };
            SessionWsMessage::ClientRequestError(ClientRequestErrorMessage::new(
                client_request_id.to_owned(),
                request_type.to_owned(),
                code,
                message.to_owned(),
                retryable,
                chat_id,
            ))
        }
        _ => return None,
    })
}
