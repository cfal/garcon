//! Ports `common/ws-events.ts`.

use std::collections::HashSet;

use garcon_js::{Number, is_integer, json::Opaque};
use serde::{Deserialize, Serialize, Serializer, ser::SerializeStruct};
use serde_json::Value;

use crate::async_user_questions::InvalidAsyncQuestionReply;
use crate::chat_activity::{ChatActivityStatus, is_chat_activity_status};
use crate::chat_boards::ChatBoardInvalidationReason;
use crate::chat_execution_control::{
    ChatExecutionControlState, parse_chat_execution_control_state,
    parse_execution_control_server_instance_id,
};
use crate::chat_search::{TranscriptSearchStatusV1, is_transcript_search_status_v1};
use crate::chat_stop::{ChatStopIntent, ChatStopOutcome};
use crate::chat_transient_feed::{
    ChatTransientFeedMutationBody, ChatTransientFeedSnapshot, parse_chat_transient_feed_mutation,
    parse_chat_transient_feed_snapshot,
};
use crate::chat_types::{ChatProcessingEntry, ChatProcessingPhase};
use crate::chat_view::{
    ResendCandidate, TranscriptMessage, TranscriptPageRelations,
    is_relationally_valid_newest_transcript_page, parse_resend_candidates,
    parse_transcript_messages,
};
use crate::executors::{ExecutorSnapshot, parse_executors};
use crate::preambles::PreamblesInvalidationReason;
use crate::project_resolution::{ProjectUnavailableReason, is_project_unavailable_reason};
use crate::scheduled_prompts::ScheduledPromptsInvalidationReason;
use crate::settings::{
    InvalidExecutorId, RemoteSettingsSnapshot, normalize_remote_settings_snapshot,
};
use crate::snippets::SnippetsInvalidationReason;
use crate::ws_revision_invalidations::{RevisionInvalidationMessage, parse_revision_invalidation};
use crate::ws_value_parsing::{
    canonical_chat_id, non_negative_int, required_path, required_str, str,
};

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

macro_rules! event_vocab {
    ($name:ident { $($variant:ident => $wire:literal),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum $name {
            $(#[serde(rename = $wire)] $variant),+
        }

        impl $name {
            fn parse(value: &Value) -> Option<Self> {
                match value.as_str()? {
                    $($wire => Some(Self::$variant),)+
                    _ => None,
                }
            }
        }
    };
}

event_vocab!(ChatReloadPhase { Preparing => "preparing", Reading => "reading", Saving => "saving" });
event_vocab!(AgentRunFinishedOutcome { Finished => "finished", Interrupted => "interrupted" });
event_vocab!(ChatOperationalNoticeType { Info => "info", Warning => "warning", Error => "error" });
event_vocab!(ChatListInvalidationReason {
    ChatAdded => "chat-added",
    PinnedToggled => "pinned-toggled",
    ArchiveToggled => "archive-toggled",
    TagsUpdated => "tags-updated",
    ParentUpdated => "parent-updated",
    ChatsReordered => "chats-reordered",
    AgentHandoff => "agent-handoff",
    ExecutionSettingsUpdated => "execution-settings-updated",
    MetadataRepaired => "metadata-repaired",
});

pub const CHAT_RELOAD_PHASES: &[ChatReloadPhase] = &[
    ChatReloadPhase::Preparing,
    ChatReloadPhase::Reading,
    ChatReloadPhase::Saving,
];

pub const CHAT_LIST_INVALIDATION_REASONS: &[ChatListInvalidationReason] = &[
    ChatListInvalidationReason::ChatAdded,
    ChatListInvalidationReason::PinnedToggled,
    ChatListInvalidationReason::ArchiveToggled,
    ChatListInvalidationReason::TagsUpdated,
    ChatListInvalidationReason::ParentUpdated,
    ChatListInvalidationReason::ChatsReordered,
    ChatListInvalidationReason::AgentHandoff,
    ChatListInvalidationReason::ExecutionSettingsUpdated,
    ChatListInvalidationReason::MetadataRepaired,
];

pub fn is_chat_list_invalidation_reason(value: &Value) -> Option<ChatListInvalidationReason> {
    ChatListInvalidationReason::parse(value)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReloadProgress {
    pub phase: ChatReloadPhase,
    pub rows: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatProjectPathUpdatedPayload {
    pub chat_id: String,
    pub project_path: String,
    pub effective_project_key: String,
    pub previous_project_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ChatOperationalNoticeDetail {
    CarryoverCompactionStarted,
    NativeTranscriptDrift,
    ProjectUnavailable {
        project_path: String,
        reason: ProjectUnavailableReason,
    },
}

macro_rules! chat_event_messages {
    ($( $name:ident ($variant:ident, $wire:literal) $(
            #[$ctor_attr:meta]
        )* { $($(#[$field_attr:meta])* $field:ident : $ty:ty,)* })*) => {
        $(
            #[derive(Debug, Clone, PartialEq, Serialize)]
            #[serde(rename_all = "camelCase")]
            pub struct $name {
                $($(#[$field_attr])* pub $field: $ty,)*
                #[serde(rename = "type")]
                message_type: &'static str,
            }

            impl $name {
                pub const TYPE: &'static str = $wire;

                $(#[$ctor_attr])*
                pub fn new($($field: $ty),*) -> Self {
                    Self { $($field,)* message_type: Self::TYPE }
                }
            }
        )*

        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum EventKey {
            $(#[serde(rename = $wire)] $variant,)*
            #[serde(rename = "reconnect-state")]
            ReconnectState,
            #[serde(rename = "ws-fault")]
            WsFault,
            #[serde(rename = "ws-pong")]
            WsPong,
            #[serde(rename = "client-request-error")]
            ClientRequestError,
            #[serde(rename = "tickets-invalidated")]
            TicketsInvalidated,
            #[serde(rename = "pull-request-reviews-invalidated")]
            PullRequestReviewsInvalidated,
            #[serde(rename = "transcript-search-status")]
            TranscriptSearchStatus,
        }

        #[derive(Debug, Clone, PartialEq, Serialize)]
        #[serde(untagged)]
        pub enum ServerWsMessage {
            $($variant($name),)*
            Session(SessionWsMessage),
            RevisionInvalidation(RevisionInvalidationMessage),
            TranscriptSearchStatus(TranscriptSearchStatusMessage),
        }

        impl ServerWsMessage {
            pub fn event_key(&self) -> EventKey {
                match self {
                    $(Self::$variant(_) => EventKey::$variant,)*
                    Self::Session(SessionWsMessage::ReconnectState(_)) => EventKey::ReconnectState,
                    Self::Session(SessionWsMessage::WsFault(_)) => EventKey::WsFault,
                    Self::Session(SessionWsMessage::WsPong(_)) => EventKey::WsPong,
                    Self::Session(SessionWsMessage::ClientRequestError(_)) => EventKey::ClientRequestError,
                    Self::RevisionInvalidation(RevisionInvalidationMessage::TicketsInvalidated(_)) => EventKey::TicketsInvalidated,
                    Self::RevisionInvalidation(RevisionInvalidationMessage::PullRequestReviewsInvalidated(_)) => EventKey::PullRequestReviewsInvalidated,
                    Self::TranscriptSearchStatus(_) => EventKey::TranscriptSearchStatus,
                }
            }
        }
    };
}

chat_event_messages! {
    ChatMessagesMessage(ChatMessages, "chat-messages")
    #[expect(clippy::too_many_arguments, reason = "mirrors the original constructor")]
    {
        chat_id: String,
        transcript_view_id: String,
        messages: Vec<TranscriptMessage>,
        first_ordinal: u64,
        last_ordinal: u64,
        resend_candidates: Vec<ResendCandidate>,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        client_request_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        upstream_request_id: Option<String>,
    }
    ChatSubscribedMessage(ChatSubscribed, "chat-subscribed")
    #[expect(clippy::too_many_arguments, reason = "mirrors the original constructor")]
    {
        client_request_id: String,
        chat_id: String,
        transcript_view_id: String,
        messages: Vec<TranscriptMessage>,
        first_ordinal: u64,
        last_ordinal: u64,
        next_after_ordinal: u64,
        through_ordinal: u64,
        has_more: bool,
        resend_candidates: Vec<ResendCandidate>,
        transient_feed: ChatTransientFeedSnapshot,
    }
    ChatTranscriptReplacedMessage(ChatTranscriptReplaced, "chat-transcript-replaced") {
        chat_id: String,
        previous_transcript_view_id: String,
        transcript_view_id: String,
        last_ordinal: u64,
    }
    ChatTransientFeedMutationMessage(ChatTransientFeedMutation, "chat-transient-feed-mutation") {
        server_instance_id: String,
        chat_id: String,
        transcript_view_id: String,
        transient_revision: u64,
        mutation: ChatTransientFeedMutationBody,
    }
    ChatReloadProgressMessage(ChatReloadProgress, "chat-reload-progress") {
        client_request_id: String,
        chat_id: String,
        phase: ChatReloadPhase,
        rows: u64,
    }
    ChatReloadedMessage(ChatReloaded, "chat-reloaded")
    #[expect(clippy::too_many_arguments, reason = "mirrors the original constructor")]
    {
        client_request_id: String,
        chat_id: String,
        transcript_view_id: String,
        messages: Vec<TranscriptMessage>,
        last_ordinal: u64,
        page_oldest_ordinal: u64,
        page_newest_ordinal: u64,
        next_before_ordinal: Option<u64>,
        has_more: bool,
    }
    AgentRunFinishedMessage(AgentRunFinished, "agent-run-finished") {
        chat_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        exit_code: Option<Number>,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        client_request_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        upstream_request_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        outcome: Option<AgentRunFinishedOutcome>,
    }
    AgentRunFailedMessage(AgentRunFailed, "agent-run-failed") {
        chat_id: String,
        error: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        client_request_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        upstream_request_id: Option<String>,
    }
    ChatSessionCreatedMessage(ChatSessionCreated, "chat-session-created") { chat_id: String, }
    ChatProjectPathUpdatedMessage(ChatProjectPathUpdated, "chat-project-path-updated") {
        chat_id: String,
        project_path: String,
        effective_project_key: String,
        previous_project_path: String,
    }
    ChatSessionStoppedMessage(ChatSessionStopped, "chat-session-stopped") {
        chat_id: String,
        outcome: ChatStopOutcome,
        intent: ChatStopIntent,
    }
    ChatProcessingUpdatedMessage(ChatProcessingUpdated, "chat-processing-updated") {
        chat_id: String,
        phase: Option<ChatProcessingPhase>,
    }
    ChatActivityUpdatedMessage(ChatActivityUpdated, "chat-activity-updated") {
        chat_id: String,
        activity_status: Option<ChatActivityStatus>,
    }
    ChatExecutionControlUpdatedMessage(ChatExecutionControlUpdated, "chat-execution-control-updated") {
        chat_id: String,
        control: Box<ChatExecutionControlState>,
    }
    ChatOperationalNoticeMessage(ChatOperationalNotice, "chat-operational-notice") {
        chat_id: String,
        notice_type: ChatOperationalNoticeType,
        content: String,
        timestamp: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<ChatOperationalNoticeDetail>,
    }
    ChatTitleUpdatedMessage(ChatTitleUpdated, "chat-title-updated") { chat_id: String, title: String, }
    ChatSessionDeletedWsMessage(ChatSessionDeleted, "chat-session-deleted") { chat_id: String, }
    ChatReadUpdatedV1Message(ChatReadUpdatedV1, "chat-read-updated-v1") {
        chat_id: String,
        last_read_at: String,
    }
    ChatListRefreshRequestedMessage(ChatListRefreshRequested, "chat-list-refresh-requested") {
        reason: ChatListInvalidationReason,
        chat_id: Option<String>,
    }
    ChatBoardsInvalidatedMessage(ChatBoardsInvalidated, "chat-boards-invalidated") {
        revision: u64,
        reason: ChatBoardInvalidationReason,
    }
    SettingsChangedMessage(SettingsChanged, "settings-changed") { settings: Box<RemoteSettingsSnapshot>, }
    ApiProvidersInvalidatedMessage(ApiProvidersInvalidated, "api-providers-invalidated") {}
    ExecutorsChangedMessage(ExecutorsChanged, "executors-changed") { executors: Vec<ExecutorSnapshot>, }
    ScheduledPromptsInvalidatedMessage(ScheduledPromptsInvalidated, "scheduled-prompts-invalidated") {
        reason: ScheduledPromptsInvalidationReason,
    }
    SnippetsInvalidatedMessage(SnippetsInvalidated, "snippets-invalidated") { reason: SnippetsInvalidationReason, }
    PreamblesInvalidatedMessage(PreamblesInvalidated, "preambles-invalidated") { reason: PreamblesInvalidationReason, }
    ChatPreamblesInvalidatedMessage(ChatPreamblesInvalidated, "chat-preambles-invalidated") {
        chat_id: String,
        revision: u64,
    }
}

impl Default for ApiProvidersInvalidatedMessage {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptSearchStatusMessage {
    status: TranscriptSearchStatusV1,
    original: Option<Opaque>,
}

impl TranscriptSearchStatusMessage {
    pub const TYPE: &'static str = "transcript-search-status";

    pub fn new(status: TranscriptSearchStatusV1) -> Self {
        Self {
            status,
            original: None,
        }
    }

    pub fn status(&self) -> &TranscriptSearchStatusV1 {
        &self.status
    }

    fn from_wire(value: &Value) -> Option<Self> {
        // The original wraps the validated object without rebuilding its keys.
        Some(Self {
            status: is_transcript_search_status_v1(value)?,
            original: Some(Opaque::from(value.clone())),
        })
    }
}

impl Serialize for TranscriptSearchStatusMessage {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut wire = serializer.serialize_struct("TranscriptSearchStatusMessage", 2)?;
        if let Some(original) = &self.original {
            wire.serialize_field("status", original)?;
        } else {
            wire.serialize_field("status", &self.status)?;
        }
        wire.serialize_field("type", Self::TYPE)?;
        wire.end()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ServerWsMessageError {
    #[error("null is not an object (evaluating 'data.type')")]
    Null,
    #[error(transparent)]
    InvalidAsyncQuestionReply(#[from] InvalidAsyncQuestionReply),
    #[error(transparent)]
    InvalidExecutorId(#[from] InvalidExecutorId),
}

fn is_valid_transcript_span(first: u64, last: u64, messages: &[TranscriptMessage]) -> bool {
    first >= 1
        && last >= first - 1
        && (last >= first || messages.is_empty())
        && messages
            .iter()
            .all(|entry| entry.ordinal.0 >= first as f64 && entry.ordinal.0 <= last as f64)
}

fn chat_processing_phase(value: &Value) -> Option<ChatProcessingPhase> {
    match value.as_str()? {
        "running" => Some(ChatProcessingPhase::Running),
        "stopping" => Some(ChatProcessingPhase::Stopping),
        "reconnecting" => Some(ChatProcessingPhase::Reconnecting),
        _ => None,
    }
}

fn parse_chat_operational_notice_detail(value: &Value) -> Option<ChatOperationalNoticeDetail> {
    let record = value.as_object()?;
    match (record.get("type")?.as_str()?, record.len()) {
        ("carryover-compaction-started", 1) => {
            Some(ChatOperationalNoticeDetail::CarryoverCompactionStarted)
        }
        ("native-transcript-drift", 1) => Some(ChatOperationalNoticeDetail::NativeTranscriptDrift),
        ("project-unavailable", 3) => Some(ChatOperationalNoticeDetail::ProjectUnavailable {
            project_path: required_path(record.get("projectPath")?)?.to_owned(),
            reason: is_project_unavailable_reason(record.get("reason")?)?,
        }),
        _ => None,
    }
}

pub fn parse_server_ws_message(
    data: &Value,
) -> Result<Option<ServerWsMessage>, ServerWsMessageError> {
    use ServerWsMessage as Message;
    if data.is_null() {
        return Err(ServerWsMessageError::Null);
    }

    macro_rules! take {
        ($value:expr) => {
            match $value {
                Some(value) => value,
                None => return Ok(None),
            }
        };
    }
    let message_type = take!(data["type"].as_str());
    let required = |field: &str| required_str(&data[field]).map(str::to_owned);
    let optional = |field: &str| data[field].as_str().map(str::to_owned);
    let nonnegative = |field: &str| non_negative_int(&data[field]);
    let chat_id = || required("chatId");
    let request_id = || required("clientRequestId");
    let view = || required("transcriptViewId");

    Ok(Some(match message_type {
        ChatMessagesMessage::TYPE => {
            let chat_id = take!(chat_id());
            let transcript_view_id = take!(view());
            let first = take!(nonnegative("firstOrdinal"));
            let last = take!(nonnegative("lastOrdinal"));
            let messages = take!(parse_transcript_messages(&data["messages"])?);
            let resend = take!(parse_resend_candidates(&data["resendCandidates"]));
            if !is_valid_transcript_span(first, last, &messages) {
                return Ok(None);
            }
            Message::ChatMessages(ChatMessagesMessage::new(
                chat_id,
                transcript_view_id,
                messages,
                first,
                last,
                resend,
                optional("turnId"),
                optional("clientRequestId"),
                optional("upstreamRequestId"),
            ))
        }
        ChatSubscribedMessage::TYPE => {
            let client_request_id = take!(request_id());
            let chat_id = take!(chat_id());
            let transcript_view_id = take!(view());
            let first = take!(nonnegative("firstOrdinal"));
            let last = take!(nonnegative("lastOrdinal"));
            let next = take!(nonnegative("nextAfterOrdinal"));
            let through = take!(nonnegative("throughOrdinal"));
            let has_more = take!(data["hasMore"].as_bool());
            let messages = parse_transcript_messages(&data["messages"])?;
            let resend = parse_resend_candidates(&data["resendCandidates"]);
            let feed = parse_chat_transient_feed_snapshot(&data["transientFeed"])?;
            let (Some(messages), Some(resend), Some(feed)) = (messages, resend, feed) else {
                return Ok(None);
            };
            if !is_valid_transcript_span(first, last, &messages)
                || next != last
                || next > through
                || has_more != (next < through)
                || (has_more && last < first)
                || feed.chat_id != chat_id
                || feed.transcript_view_id != transcript_view_id
            {
                return Ok(None);
            }
            Message::ChatSubscribed(ChatSubscribedMessage::new(
                client_request_id,
                chat_id,
                transcript_view_id,
                messages,
                first,
                last,
                next,
                through,
                has_more,
                resend,
                feed,
            ))
        }
        ChatTranscriptReplacedMessage::TYPE => {
            Message::ChatTranscriptReplaced(ChatTranscriptReplacedMessage::new(
                take!(chat_id()),
                take!(required("previousTranscriptViewId")),
                take!(view()),
                take!(nonnegative("lastOrdinal")),
            ))
        }
        ChatTransientFeedMutationMessage::TYPE => {
            let parsed = take!(parse_chat_transient_feed_mutation(data)?);
            Message::ChatTransientFeedMutation(ChatTransientFeedMutationMessage::new(
                parsed.server_instance_id,
                parsed.chat_id,
                parsed.transcript_view_id,
                parsed.transient_revision,
                parsed.mutation,
            ))
        }
        ChatReloadProgressMessage::TYPE => {
            let client_request_id = take!(request_id());
            let chat_id = take!(chat_id());
            let rows = take!(nonnegative("rows"));
            let phase = take!(ChatReloadPhase::parse(&data["phase"]));
            Message::ChatReloadProgress(ChatReloadProgressMessage::new(
                client_request_id,
                chat_id,
                phase,
                rows,
            ))
        }
        ChatReloadedMessage::TYPE => {
            let client_request_id = take!(request_id());
            let chat_id = take!(chat_id());
            let transcript_view_id = take!(view());
            let last = take!(nonnegative("lastOrdinal"));
            let oldest = take!(nonnegative("pageOldestOrdinal"));
            let newest = take!(nonnegative("pageNewestOrdinal"));
            let next = match data.get("nextBeforeOrdinal") {
                Some(Value::Null) => None,
                Some(value) => Some(take!(non_negative_int(value).filter(|&number| number > 1))),
                None => return Ok(None),
            };
            let has_more = take!(data["hasMore"].as_bool());
            let messages = take!(parse_transcript_messages(&data["messages"])?);
            if !is_relationally_valid_newest_transcript_page(TranscriptPageRelations {
                messages: &messages,
                last_ordinal: last as f64,
                page_oldest_ordinal: oldest as f64,
                page_newest_ordinal: newest as f64,
                next_before_ordinal: next.map(|number| number as f64),
                has_more,
            }) {
                return Ok(None);
            }
            Message::ChatReloaded(ChatReloadedMessage::new(
                client_request_id,
                chat_id,
                transcript_view_id,
                messages,
                last,
                oldest,
                newest,
                next,
                has_more,
            ))
        }
        AgentRunFinishedMessage::TYPE => {
            let chat_id = take!(chat_id());
            let exit_code = match data.get("exitCode") {
                Some(value) => Some(Number(take!(
                    value.as_f64().filter(|&number| is_integer(number))
                ))),
                None => None,
            };
            let outcome = match data.get("outcome") {
                Some(value) => Some(take!(AgentRunFinishedOutcome::parse(value))),
                None => None,
            };
            Message::AgentRunFinished(AgentRunFinishedMessage::new(
                chat_id,
                exit_code,
                optional("turnId"),
                optional("clientRequestId"),
                optional("upstreamRequestId"),
                outcome,
            ))
        }
        AgentRunFailedMessage::TYPE => Message::AgentRunFailed(AgentRunFailedMessage::new(
            take!(chat_id()),
            take!(required("error")),
            optional("turnId"),
            optional("clientRequestId"),
            optional("upstreamRequestId"),
        )),
        ChatSessionCreatedMessage::TYPE => {
            Message::ChatSessionCreated(ChatSessionCreatedMessage::new(take!(chat_id())))
        }
        ChatProjectPathUpdatedMessage::TYPE => {
            Message::ChatProjectPathUpdated(ChatProjectPathUpdatedMessage::new(
                take!(chat_id()),
                take!(required_path(&data["projectPath"])).to_owned(),
                take!(required_path(&data["effectiveProjectKey"])).to_owned(),
                take!(required_path(&data["previousProjectPath"])).to_owned(),
            ))
        }
        ChatSessionStoppedMessage::TYPE => {
            let chat_id = take!(chat_id());
            let intent = match data["intent"].as_str() {
                Some("stop") => ChatStopIntent::Stop,
                Some("interrupt-and-send") => ChatStopIntent::InterruptAndSend,
                Some("chat-deletion") => ChatStopIntent::ChatDeletion,
                _ => return Ok(None),
            };
            let outcome = match data["outcome"].as_str() {
                Some("interrupt-requested") => ChatStopOutcome::InterruptRequested,
                Some("already-idle") => ChatStopOutcome::AlreadyIdle,
                Some("failed") => ChatStopOutcome::Failed,
                _ => return Ok(None),
            };
            Message::ChatSessionStopped(ChatSessionStoppedMessage::new(chat_id, outcome, intent))
        }
        ChatProcessingUpdatedMessage::TYPE => {
            let chat_id = take!(chat_id());
            let phase = match data.get("phase") {
                Some(Value::Null) => None,
                value => Some(take!(value.and_then(chat_processing_phase))),
            };
            Message::ChatProcessingUpdated(ChatProcessingUpdatedMessage::new(chat_id, phase))
        }
        ChatActivityUpdatedMessage::TYPE => {
            let chat_id = take!(chat_id());
            let status = match data.get("activityStatus") {
                Some(Value::Null) => None,
                value => Some(take!(value.and_then(is_chat_activity_status))),
            };
            Message::ChatActivityUpdated(ChatActivityUpdatedMessage::new(chat_id, status))
        }
        ChatExecutionControlUpdatedMessage::TYPE => {
            Message::ChatExecutionControlUpdated(ChatExecutionControlUpdatedMessage::new(
                take!(chat_id()),
                Box::new(take!(parse_chat_execution_control_state(&data["control"]))),
            ))
        }
        ChatOperationalNoticeMessage::TYPE => {
            let chat_id = take!(chat_id());
            let content = take!(required("content"));
            let notice_type = take!(ChatOperationalNoticeType::parse(&data["noticeType"]));
            let detail = match data.get("detail") {
                None => None,
                Some(value) => Some(take!(parse_chat_operational_notice_detail(value))),
            };
            Message::ChatOperationalNotice(ChatOperationalNoticeMessage::new(
                chat_id,
                notice_type,
                content,
                str(&data["timestamp"]).to_owned(),
                detail,
            ))
        }
        ReconnectStateMessage::TYPE
        | WsFaultMessage::TYPE
        | WsPongMessage::TYPE
        | ClientRequestErrorMessage::TYPE => {
            Message::Session(take!(parse_session_ws_message(data)))
        }
        ChatTitleUpdatedMessage::TYPE => Message::ChatTitleUpdated(ChatTitleUpdatedMessage::new(
            take!(chat_id()),
            str(&data["title"]).to_owned(),
        )),
        ChatSessionDeletedWsMessage::TYPE => {
            Message::ChatSessionDeleted(ChatSessionDeletedWsMessage::new(take!(chat_id())))
        }
        ChatReadUpdatedV1Message::TYPE => Message::ChatReadUpdatedV1(
            ChatReadUpdatedV1Message::new(take!(chat_id()), take!(required("lastReadAt"))),
        ),
        ChatListRefreshRequestedMessage::TYPE => {
            let reason = take!(is_chat_list_invalidation_reason(&data["reason"]));
            let chat_id = if reason == ChatListInvalidationReason::MetadataRepaired {
                if data.get("chatId") != Some(&Value::Null) {
                    return Ok(None);
                }
                None
            } else {
                Some(take!(chat_id()))
            };
            Message::ChatListRefreshRequested(ChatListRefreshRequestedMessage::new(reason, chat_id))
        }
        ChatBoardsInvalidatedMessage::TYPE => {
            if !data.as_object().is_some_and(|record| {
                record.len() == 3
                    && record.contains_key("revision")
                    && record.contains_key("reason")
            }) {
                return Ok(None);
            }
            let revision = take!(nonnegative("revision"));
            let reason = match data["reason"].as_str() {
                Some("created") => ChatBoardInvalidationReason::Created,
                Some("updated") => ChatBoardInvalidationReason::Updated,
                Some("removed") => ChatBoardInvalidationReason::Removed,
                Some("reordered") => ChatBoardInvalidationReason::Reordered,
                _ => return Ok(None),
            };
            Message::ChatBoardsInvalidated(ChatBoardsInvalidatedMessage::new(revision, reason))
        }
        "tickets-invalidated" | "pull-request-reviews-invalidated" => {
            Message::RevisionInvalidation(take!(parse_revision_invalidation(data)))
        }
        SettingsChangedMessage::TYPE => {
            Message::SettingsChanged(SettingsChangedMessage::new(Box::new(take!(
                normalize_remote_settings_snapshot(&data["settings"])?
            ))))
        }
        ApiProvidersInvalidatedMessage::TYPE => {
            if !data.as_object().is_some_and(|record| record.len() == 1) {
                return Ok(None);
            }
            Message::ApiProvidersInvalidated(ApiProvidersInvalidatedMessage::new())
        }
        ExecutorsChangedMessage::TYPE => Message::ExecutorsChanged(ExecutorsChangedMessage::new(
            take!(parse_executors(&data["executors"])),
        )),
        TranscriptSearchStatusMessage::TYPE => Message::TranscriptSearchStatus(take!(
            TranscriptSearchStatusMessage::from_wire(&data["status"])
        )),
        ScheduledPromptsInvalidatedMessage::TYPE => {
            let reason = match data["reason"].as_str() {
                Some("created") => ScheduledPromptsInvalidationReason::Created,
                Some("updated") => ScheduledPromptsInvalidationReason::Updated,
                Some("removed") => ScheduledPromptsInvalidationReason::Removed,
                Some("reordered") => ScheduledPromptsInvalidationReason::Reordered,
                Some("executed") => ScheduledPromptsInvalidationReason::Executed,
                Some("missed") => ScheduledPromptsInvalidationReason::Missed,
                Some("log-appended") => ScheduledPromptsInvalidationReason::LogAppended,
                _ => return Ok(None),
            };
            Message::ScheduledPromptsInvalidated(ScheduledPromptsInvalidatedMessage::new(reason))
        }
        SnippetsInvalidatedMessage::TYPE => {
            let reason = match data["reason"].as_str() {
                Some("created") => SnippetsInvalidationReason::Created,
                Some("updated") => SnippetsInvalidationReason::Updated,
                Some("removed") => SnippetsInvalidationReason::Removed,
                _ => return Ok(None),
            };
            Message::SnippetsInvalidated(SnippetsInvalidatedMessage::new(reason))
        }
        PreamblesInvalidatedMessage::TYPE => {
            let reason = match data["reason"].as_str() {
                Some("created") => PreamblesInvalidationReason::Created,
                Some("updated") => PreamblesInvalidationReason::Updated,
                Some("removed") => PreamblesInvalidationReason::Removed,
                Some("reordered") => PreamblesInvalidationReason::Reordered,
                _ => return Ok(None),
            };
            Message::PreamblesInvalidated(PreamblesInvalidatedMessage::new(reason))
        }
        ChatPreamblesInvalidatedMessage::TYPE => {
            Message::ChatPreamblesInvalidated(ChatPreamblesInvalidatedMessage::new(
                take!(canonical_chat_id(&data["chatId"])).to_string(),
                take!(nonnegative("revision")),
            ))
        }
        _ => return Ok(None),
    }))
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
                let phase = chat_processing_phase(&entry["phase"])?;
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
