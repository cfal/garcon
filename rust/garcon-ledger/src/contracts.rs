use std::{collections::HashSet, fmt};

use garcon_contract::{
    agent_execution::AgentAttachment,
    chat_command_contracts::PermissionDecisionPayload,
    chat_types::{ChatMessage, ToolUseChatMessage, UserMessage},
    cli_presentation::{
        CliBodyDisclosure, CliRowFormat, is_cli_body_disclosure, is_cli_presentation,
        is_cli_row_format,
    },
    command_request_validation::is_command_correlation_id_within_limit,
    garcon_command_results::{AgentCommandOutcomeNoticeDetail, parse_agent_command_outcome},
    garcon_ticket_result::{TicketCommandOutcome, parse_stored_ticket_command_outcome},
    preamble_prefix::PreamblePrefixReceipt,
    preambles::{
        PREAMBLE_MAX_COUNT, PendingPreambleBoundary, Preamble, is_preamble_id,
        normalize_preamble_title,
    },
    tool_result_message::ToolResultMessage,
};
use garcon_interface::producer::{
    AgentEstablishedSession, AgentPermissionOption, AgentRunFailureDetail,
};
use garcon_js::{
    is_safe_integer,
    json::{Opaque, as_number},
    trim,
};
use serde::Serialize;
use serde_json::Value;

use crate::errors::LedgerCodecError;

pub fn project_ledger_ticket_command_outcome(detail: &Value) -> Option<TicketCommandOutcome> {
    parse_stored_ticket_command_outcome(&public_fields(
        detail,
        &[
            "type",
            "command",
            "ref",
            "ticketId",
            "requestViewId",
            "requestOrdinal",
            "status",
            "revision",
            "errorCode",
            "context",
        ],
    ))
}

pub fn project_ledger_agent_command_outcome(
    detail: &Value,
) -> Option<AgentCommandOutcomeNoticeDetail> {
    parse_agent_command_outcome(&public_fields(
        detail,
        &[
            "type",
            "requestViewId",
            "requestOrdinal",
            "status",
            "chatId",
            "reason",
            "scheduleId",
            "nextRunAt",
            "intervalMinutes",
            "endAtUtc",
            "busyBehavior",
            "ref",
            "async",
            "output",
            "errorCode",
        ],
    ))
}

fn public_fields(detail: &Value, keys: &[&str]) -> Value {
    Value::Object(
        keys.iter()
            .filter_map(|&key| Some((key.to_owned(), detail.get(key)?.clone())))
            .collect(),
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct TranscriptViewId(pub(crate) String);

impl TranscriptViewId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for TranscriptViewId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

pub fn transcript_view_id(value: &str) -> Result<TranscriptViewId, LedgerCodecError> {
    if value.is_empty() {
        return Err(LedgerCodecError::Type(
            "Transcript view ID is required".into(),
        ));
    }
    Ok(TranscriptViewId(value.into()))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptViewStatus {
    Current,
    Staging,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptView {
    pub view_id: TranscriptViewId,
    pub status: TranscriptViewStatus,
    pub created_at: String,
    pub content_start_ordinal: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerRow {
    pub view_id: TranscriptViewId,
    pub ordinal: u64,
    pub at: String,
    pub provider_meta: Option<Opaque>,
    #[serde(flatten)]
    pub data: LedgerRowData,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerUserInputDetail {
    pub client_message_id: Option<String>,
    pub message: UserMessage,
    pub attachments: Vec<AgentAttachment>,
    pub steer: bool,
    pub preamble_boundary: Option<PendingPreambleBoundary>,
    pub preamble_prefix_receipt: Option<PreamblePrefixReceipt>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum LedgerNoticeDetail {
    CliRow(LedgerCliRowNoticeDetail),
    PreambleSelectionChanged(LedgerPreambleSelectionChangedNoticeDetail),
    Other(Opaque),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename = "cli-row", rename_all = "camelCase")]
pub struct LedgerCliRowNoticeDetail {
    pub client_message_id: String,
    pub presentation: Opaque,
    pub format: CliRowFormat,
    pub disclosure: CliBodyDisclosure,
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename = "preamble-selection-change",
    rename_all = "camelCase"
)]
pub struct LedgerPreambleSelectionChangedNoticeDetail {
    pub client_message_id: String,
    pub request_fingerprint: String,
    pub selection_revision: u64,
    pub preambles: Vec<Opaque>,
}

pub fn is_ledger_preamble_selection_changed_notice_detail(value: &Value) -> bool {
    let Some(client_message_id) = value["clientMessageId"].as_str() else {
        return false;
    };
    if value["type"] != "preamble-selection-change"
        || client_message_id.is_empty()
        || trim(client_message_id) != client_message_id
        || !is_command_correlation_id_within_limit(client_message_id)
        || !non_empty(&value["requestFingerprint"])
        || !as_number(&value["selectionRevision"]).is_some_and(|n| n >= 0.0 && is_safe_integer(n))
    {
        return false;
    }
    let Some(preambles) = value["preambles"].as_array() else {
        return false;
    };
    let allowed = [
        "type",
        "clientMessageId",
        "requestFingerprint",
        "selectionRevision",
        "preambles",
    ];
    if preambles.len() > PREAMBLE_MAX_COUNT
        || !value
            .as_object()
            .is_some_and(|obj| obj.keys().all(|key| allowed.contains(&key.as_str())))
    {
        return false;
    }
    let mut ids = HashSet::new();
    for entry in preambles {
        let Some(entry) = entry.as_object() else {
            return false;
        };
        let (Some(id), Some(title)) = (entry.get("id"), entry.get("title")) else {
            return false;
        };
        if entry.len() != 2
            || !is_preamble_id(id)
            || !ids.insert(id.as_str())
            || match normalize_preamble_title(title) {
                Some(normalized) => title.as_str() != Some(&normalized),
                None => !title.is_null(),
            }
        {
            return false;
        }
    }
    true
}

pub fn is_ledger_cli_row_notice_detail(value: &Value) -> bool {
    value["type"] == "cli-row"
        && non_empty(&value["clientMessageId"])
        && is_cli_presentation(&value["presentation"]).is_some()
        && is_cli_row_format(&value["format"]).is_some()
        && is_cli_body_disclosure(&value["disclosure"]).is_some()
        && value
            .get("title")
            .is_some_and(|title| title.is_null() || non_empty(title))
}

fn non_empty(value: &Value) -> bool {
    value.as_str().is_some_and(|text| !text.is_empty())
}

pub fn is_ledger_cli_row_notice_row(row: &LedgerRow) -> bool {
    row.provider_meta.is_none()
        && matches!(
            &row.data,
            LedgerRowData::Notice {
                detail: LedgerNoticeDetail::CliRow(_),
                ..
            }
        )
}

pub fn is_ledger_preamble_selection_changed_notice_row(row: &LedgerRow) -> bool {
    row.provider_meta.is_none()
        && matches!(
            &row.data,
            LedgerRowData::Notice {
                detail: LedgerNoticeDetail::PreambleSelectionChanged(_),
                ..
            }
        )
}

pub const PREAMBLES_UPDATED_MESSAGE: &str = "Preambles updated";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerAgentSwitchDetail {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_executor_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to_executor_id: Option<String>,
    pub from_agent_id: String,
    pub to_agent_id: String,
    pub from_model: Option<String>,
    pub to_model: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RunOutcome {
    Finished,
    Failed,
    Interrupted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RunOrigin {
    Provider,
    Core,
}

// The stored decoder accepts any normalized message with a toolId. The
// provider API only emits ToolUse, but a stored ToolResult also passes.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum LedgerPermissionTool {
    ToolUse(Box<ToolUseChatMessage>),
    ToolResult(ToolResultMessage),
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum LedgerPermissionLifecycle {
    Requested {
        permission_occurrence_id: String,
        requested_tool: LedgerPermissionTool,
        options: Vec<AgentPermissionOption>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    Resolved {
        permission_occurrence_id: String,
        decision: PermissionDecisionPayload,
    },
    Cancelled {
        permission_occurrence_id: String,
        reason: Option<String>,
    },
    Expired {
        permission_occurrence_id: String,
    },
}

impl LedgerPermissionLifecycle {
    pub fn row_kind(&self) -> &'static str {
        match self {
            Self::Requested { .. } => "permission-requested",
            Self::Resolved { .. } => "permission-resolved",
            Self::Cancelled { .. } => "permission-cancelled",
            Self::Expired { .. } => "permission-expired",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum LedgerRowData {
    UserInput {
        detail: LedgerUserInputDetail,
    },
    ProviderRow {
        message: ChatMessage,
    },
    Notice {
        message: String,
        detail: LedgerNoticeDetail,
    },
    AgentSwitch {
        detail: LedgerAgentSwitchDetail,
    },
    Session {
        detail: AgentEstablishedSession,
    },
    RunEnded {
        outcome: RunOutcome,
        origin: RunOrigin,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<AgentRunFailureDetail>,
    },
    PermissionRequested {
        lifecycle: LedgerPermissionLifecycle,
    },
    PermissionResolved {
        lifecycle: LedgerPermissionLifecycle,
    },
    PermissionCancelled {
        lifecycle: LedgerPermissionLifecycle,
    },
    PermissionExpired {
        lifecycle: LedgerPermissionLifecycle,
    },
}

impl LedgerRowData {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::UserInput { .. } => "user-input",
            Self::ProviderRow { .. } => "provider-row",
            Self::Notice { .. } => "notice",
            Self::AgentSwitch { .. } => "agent-switch",
            Self::Session { .. } => "session",
            Self::RunEnded { .. } => "run-ended",
            Self::PermissionRequested { .. } => "permission-requested",
            Self::PermissionResolved { .. } => "permission-resolved",
            Self::PermissionCancelled { .. } => "permission-cancelled",
            Self::PermissionExpired { .. } => "permission-expired",
        }
    }
}

pub fn is_presentation_only_provider_row(row: &LedgerRow) -> bool {
    matches!(
        &row.data,
        LedgerRowData::ProviderRow {
            message: ChatMessage::Error(_) | ChatMessage::CliRow(_),
        }
    )
}

pub fn is_conversational_ledger_row(row: &LedgerRow) -> bool {
    matches!(row.data, LedgerRowData::UserInput { .. })
        || (matches!(row.data, LedgerRowData::ProviderRow { .. })
            && !is_presentation_only_provider_row(row))
}

#[derive(Debug, Clone, PartialEq)]
pub struct LedgerRowDraft {
    pub at: String,
    pub provider_meta: Option<Opaque>,
    pub data: LedgerRowData,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPage {
    pub view_id: TranscriptViewId,
    pub rows: Vec<LedgerRow>,
    pub next_before: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputComposition {
    pub input: LedgerRow,
    pub committed_rows: Vec<LedgerRow>,
    pub prompt: Vec<LedgerRow>,
    pub provider_prefix: String,
    pub inserted: bool,
}

pub struct AppendInputRequest<'a> {
    pub view_id: &'a TranscriptViewId,
    pub at: &'a str,
    pub detail: &'a LedgerUserInputDetail,
    pub excluded_ordinals: Option<&'a HashSet<u64>>,
    pub preamble_boundary: Option<&'a PendingPreambleBoundary>,
    pub preambles: &'a [Preamble],
}

pub struct AppendChatRowRequest<'a> {
    pub view_id: &'a TranscriptViewId,
    pub at: &'a str,
    pub message: &'a str,
    pub detail: &'a LedgerCliRowNoticeDetail,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendChatRowResult {
    pub row: LedgerRow,
    pub inserted: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendSelectionChangeNoticeResult {
    pub row: LedgerRow,
    pub inserted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerCheckpoint {
    pub view_id: TranscriptViewId,
    pub ordinal: u64,
    pub log_frames: i64,
    pub checkpointed_frames: i64,
}
