//! Ports `common/chat-view.ts`.

use garcon_js::{Number, is_integer, is_safe_integer, json::as_number, trim};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::async_user_questions::InvalidAsyncQuestionReply;
use crate::chat_types::{ChatMessage, ErrorMessage, parse_chat_message};

pub const CHAT_MESSAGES_MAX_LIMIT: u64 = 200;
pub const CHAT_MESSAGES_DEFAULT_LIMIT: u64 = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptReadPurpose {
    Activation,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TranscriptMessage {
    pub ordinal: Number,
    pub message: ChatMessage,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResendCandidate {
    pub ordinal: Number,
    pub content: String,
    pub attachment_names: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPage {
    pub transcript_view_id: String,
    pub messages: Vec<TranscriptMessage>,
    pub last_ordinal: u64,
    pub page_oldest_ordinal: u64,
    pub page_newest_ordinal: u64,
    pub next_before_ordinal: Option<u64>,
    pub has_more: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct TranscriptPageRelations<'a> {
    pub messages: &'a [TranscriptMessage],
    pub last_ordinal: f64,
    pub page_oldest_ordinal: f64,
    pub page_newest_ordinal: f64,
    pub next_before_ordinal: Option<f64>,
    pub has_more: bool,
}

pub fn is_relationally_valid_transcript_page(page: TranscriptPageRelations<'_>) -> bool {
    if !is_safe_integer(page.last_ordinal)
        || page.last_ordinal < 0.0
        || !is_safe_integer(page.page_oldest_ordinal)
        || page.page_oldest_ordinal < 0.0
        || !is_safe_integer(page.page_newest_ordinal)
        || page.page_newest_ordinal < 0.0
        || page.page_oldest_ordinal > page.page_newest_ordinal
        || page.page_newest_ordinal > page.last_ordinal
        || page.next_before_ordinal.is_some_and(|next| {
            !is_safe_integer(next) || next <= 1.0 || next > page.page_newest_ordinal
        })
        || page.has_more != page.next_before_ordinal.is_some()
    {
        return false;
    }
    let Some(first) = page.messages.first() else {
        return page.page_oldest_ordinal == 0.0;
    };
    if page.page_oldest_ordinal == 0.0
        || first.ordinal.0 != page.page_oldest_ordinal
        || page
            .next_before_ordinal
            .is_some_and(|next| next > page.page_oldest_ordinal)
    {
        return false;
    }
    let mut previous = 0.0;
    for entry in page.messages {
        let ordinal = entry.ordinal.0;
        if !is_safe_integer(ordinal)
            || ordinal <= previous
            || ordinal < page.page_oldest_ordinal
            || ordinal > page.page_newest_ordinal
        {
            return false;
        }
        previous = ordinal;
    }
    true
}

pub fn is_relationally_valid_bounded_transcript_page(
    page: TranscriptPageRelations<'_>,
    limit: f64,
) -> bool {
    if !is_safe_integer(limit) || limit <= 0.0 || !is_relationally_valid_transcript_page(page) {
        return false;
    }
    let continuation = page.page_newest_ordinal - limit + 1.0;
    page.next_before_ordinal == (continuation > 1.0).then_some(continuation)
}

pub fn is_relationally_valid_newest_transcript_page(page: TranscriptPageRelations<'_>) -> bool {
    page.page_newest_ordinal == page.last_ordinal && is_relationally_valid_transcript_page(page)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum ChatHistoryState {
    Complete,
    Degraded { error_code: String, retryable: bool },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteChatHistoryResponse {
    pub history_state: ChatHistoryState,
    pub chat_id: String,
    pub messages: Vec<TranscriptMessage>,
    pub resend_candidates: Vec<ResendCandidate>,
    pub transcript_view_id: String,
    pub last_ordinal: u64,
    pub page_oldest_ordinal: u64,
    pub page_newest_ordinal: u64,
    pub next_before_ordinal: Option<u64>,
    pub has_more: bool,
    pub limit: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnavailableChatHistoryResponse {
    pub history_state: ChatHistoryState,
    pub chat_id: String,
    pub messages: [TranscriptMessage; 0],
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum ChatHistoryResponse {
    Complete(CompleteChatHistoryResponse),
    Unavailable(UnavailableChatHistoryResponse),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessagesRequest {
    pub chat_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before_ordinal: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_view_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub purpose: Option<TranscriptReadPurpose>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum InvalidHistoryPage {
    #[error("Invalid chat messages page: {0}")]
    Field(String),
    #[error(transparent)]
    Message(#[from] InvalidAsyncQuestionReply),
}

impl InvalidHistoryPage {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Field(_) => "Error",
            Self::Message(_) => "TypeError",
        }
    }
}

pub fn parse_chat_history_response(
    request: &ChatMessagesRequest,
    value: &Value,
) -> Result<ChatHistoryResponse, InvalidHistoryPage> {
    let history_state =
        parse_chat_history_state(&value["historyState"]).ok_or_else(|| invalid("historyState"))?;
    let chat_id = required_string(&value["chatId"], "chatId")?;
    if chat_id != request.chat_id {
        return Err(invalid("chatId does not match request"));
    }
    if history_state != ChatHistoryState::Complete {
        if !value["messages"].as_array().is_some_and(Vec::is_empty) {
            return Err(invalid("unavailable messages"));
        }
        for field in [
            "transcriptViewId",
            "lastOrdinal",
            "pageOldestOrdinal",
            "pageNewestOrdinal",
            "nextBeforeOrdinal",
            "hasMore",
            "limit",
        ] {
            if value.get(field).is_some() {
                return Err(invalid(format!("unavailable {field}")));
            }
        }
        return Ok(ChatHistoryResponse::Unavailable(
            UnavailableChatHistoryResponse {
                history_state,
                chat_id,
                messages: [],
            },
        ));
    }
    let messages =
        parse_transcript_messages(&value["messages"])?.ok_or_else(|| invalid("messages"))?;
    let resend_candidates = parse_resend_candidates(&value["resendCandidates"])
        .ok_or_else(|| invalid("resendCandidates"))?;
    let has_more = value["hasMore"]
        .as_bool()
        .ok_or_else(|| invalid("hasMore"))?;
    let page = CompleteChatHistoryResponse {
        history_state,
        chat_id,
        messages,
        resend_candidates,
        transcript_view_id: required_string(&value["transcriptViewId"], "transcriptViewId")?,
        last_ordinal: required_integer(&value["lastOrdinal"], "lastOrdinal", 0.0)?,
        page_oldest_ordinal: required_integer(
            &value["pageOldestOrdinal"],
            "pageOldestOrdinal",
            0.0,
        )?,
        page_newest_ordinal: required_integer(
            &value["pageNewestOrdinal"],
            "pageNewestOrdinal",
            0.0,
        )?,
        next_before_ordinal: match value.get("nextBeforeOrdinal") {
            Some(Value::Null) => None,
            Some(value) => Some(required_integer(value, "nextBeforeOrdinal", 1.0)?),
            None => return Err(invalid("nextBeforeOrdinal")),
        },
        has_more,
        limit: required_integer(&value["limit"], "limit", 1.0)?,
    };
    validate_chat_history_page(request, &page)?;
    Ok(ChatHistoryResponse::Complete(page))
}

fn validate_chat_history_page(
    request: &ChatMessagesRequest,
    page: &CompleteChatHistoryResponse,
) -> Result<(), InvalidHistoryPage> {
    let requested_limit = request
        .limit
        .map_or(CHAT_MESSAGES_DEFAULT_LIMIT as f64, |n| n.0);
    let limit = js_min(requested_limit, CHAT_MESSAGES_MAX_LIMIT as f64);
    if page.limit as f64 != limit {
        return Err(invalid("limit does not match request"));
    }
    if request
        .transcript_view_id
        .as_ref()
        .is_some_and(|view| *view != page.transcript_view_id)
    {
        return Err(invalid("transcriptViewId does not match request"));
    }
    let end = page.last_ordinal as f64 + 1.0;
    let before = js_min(request.before_ordinal.map_or(end, |n| n.0), end);
    if page.page_newest_ordinal as f64 != before - 1.0 {
        return Err(invalid(
            "pageNewestOrdinal does not match the effective request boundary",
        ));
    }
    if page.messages.len() as u64 > page.limit {
        return Err(invalid("messages exceed limit"));
    }
    let relations = TranscriptPageRelations {
        messages: &page.messages,
        last_ordinal: page.last_ordinal as f64,
        page_oldest_ordinal: page.page_oldest_ordinal as f64,
        page_newest_ordinal: page.page_newest_ordinal as f64,
        next_before_ordinal: page.next_before_ordinal.map(|n| n as f64),
        has_more: page.has_more,
    };
    if !is_relationally_valid_transcript_page(relations) {
        return Err(invalid("ordinal relations"));
    }
    if !is_relationally_valid_bounded_transcript_page(relations, page.limit as f64) {
        return Err(invalid("raw continuation"));
    }
    Ok(())
}

fn js_min(left: f64, right: f64) -> f64 {
    if left.is_nan() { left } else { left.min(right) }
}

fn invalid(reason: impl Into<String>) -> InvalidHistoryPage {
    InvalidHistoryPage::Field(reason.into())
}

fn required_string(value: &Value, field: &str) -> Result<String, InvalidHistoryPage> {
    value
        .as_str()
        .filter(|s| !trim(s).is_empty())
        .map(str::to_owned)
        .ok_or_else(|| invalid(field))
}

fn required_integer(value: &Value, field: &str, minimum: f64) -> Result<u64, InvalidHistoryPage> {
    as_number(value)
        .filter(|&n| is_safe_integer(n) && n >= minimum)
        .map(|n| n as u64)
        .ok_or_else(|| invalid(field))
}

pub fn is_unavailable_chat_history_response(response: &ChatHistoryResponse) -> bool {
    matches!(response, ChatHistoryResponse::Unavailable(_))
}

pub fn parse_chat_history_state(value: &Value) -> Option<ChatHistoryState> {
    let raw = value.as_object()?;
    match value["kind"].as_str()? {
        "complete" if raw.len() == 1 => Some(ChatHistoryState::Complete),
        "degraded" if raw.len() == 3 => {
            let code = value["errorCode"]
                .as_str()
                .filter(|code| valid_history_error_code(code))?;
            Some(ChatHistoryState::Degraded {
                error_code: code.to_owned(),
                retryable: value["retryable"].as_bool()?,
            })
        }
        _ => None,
    }
}

pub(crate) fn valid_history_error_code(value: &str) -> bool {
    value.len() <= 64
        && value.as_bytes().split_first().is_some_and(|(first, rest)| {
            first.is_ascii_uppercase()
                && rest
                    .iter()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || *b == b'_')
        })
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptAppend {
    pub transcript_view_id: String,
    pub first_ordinal: Number,
    pub last_ordinal: Number,
    pub messages: Vec<TranscriptMessage>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptReplayResult {
    #[serde(flatten)]
    pub append: TranscriptAppend,
    pub next_after_ordinal: Number,
    pub through_ordinal: Number,
    pub has_more: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TranscriptApplyStatus {
    Applied,
    GapDetected,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptApplyResult {
    pub messages: Vec<TranscriptMessage>,
    pub changed: bool,
    pub last_ordinal: Number,
    pub status: TranscriptApplyStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_ordinal: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub received_ordinal: Option<Number>,
}

fn is_positive_int(number: f64) -> bool {
    is_integer(number) && number > 0.0
}

pub fn parse_transcript_message(
    value: &Value,
) -> Result<Option<TranscriptMessage>, InvalidAsyncQuestionReply> {
    let Some(ordinal) = as_number(&value["ordinal"]).filter(|&n| is_positive_int(n)) else {
        return Ok(None);
    };
    let raw = &value["message"];
    let message = parse_chat_message(raw)?.unwrap_or_else(|| {
        ChatMessage::Error(ErrorMessage {
            timestamp: raw["timestamp"].as_str().unwrap_or_default().to_owned(),
            content: "This message type is not supported by this app version. Reload to update."
                .to_owned(),
        })
    });
    Ok(Some(TranscriptMessage {
        ordinal: Number(ordinal),
        message,
    }))
}

pub fn parse_transcript_messages(
    value: &Value,
) -> Result<Option<Vec<TranscriptMessage>>, InvalidAsyncQuestionReply> {
    let Some(values) = value.as_array() else {
        return Ok(None);
    };
    let mut messages = Vec::with_capacity(values.len());
    let mut previous = 0.0;
    for value in values {
        let Some(message) = parse_transcript_message(value)? else {
            return Ok(None);
        };
        if message.ordinal.0 <= previous {
            return Ok(None);
        }
        previous = message.ordinal.0;
        messages.push(message);
    }
    Ok(Some(messages))
}

pub fn parse_resend_candidates(value: &Value) -> Option<Vec<ResendCandidate>> {
    let values = value.as_array()?;
    let mut candidates = Vec::with_capacity(values.len());
    let mut previous = 0.0;
    for value in values {
        let ordinal =
            as_number(&value["ordinal"]).filter(|&n| is_positive_int(n) && n > previous)?;
        let content = value["content"].as_str()?.to_owned();
        let attachment_names = value["attachmentNames"]
            .as_array()?
            .iter()
            .map(|name| name.as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()?;
        candidates.push(ResendCandidate {
            ordinal: Number(ordinal),
            content,
            attachment_names,
        });
        previous = ordinal;
    }
    Some(candidates)
}

pub fn apply_transcript_append(
    mut current: Vec<TranscriptMessage>,
    append: &TranscriptAppend,
    current_last_ordinal: Number,
) -> TranscriptApplyResult {
    let first = append.first_ordinal.0;
    let last = append.last_ordinal.0;
    let mut previous = 0.0;
    let invalid_message_ordinal = append.messages.iter().any(|entry| {
        let ordinal = entry.ordinal.0;
        let invalid =
            !is_positive_int(ordinal) || ordinal <= previous || ordinal < first || ordinal > last;
        previous = ordinal;
        invalid
    });
    let outcome = |messages, changed, last_ordinal, gap: bool| TranscriptApplyResult {
        messages,
        changed,
        last_ordinal,
        status: if gap {
            TranscriptApplyStatus::GapDetected
        } else {
            TranscriptApplyStatus::Applied
        },
        expected_ordinal: gap.then_some(Number(current_last_ordinal.0 + 1.0)),
        received_ordinal: gap.then_some(append.first_ordinal),
    };
    if !is_positive_int(first)
        || !is_safe_integer(last)
        || last < 0.0
        || last < first - 1.0
        || (last < first && !append.messages.is_empty())
        || invalid_message_ordinal
    {
        return outcome(current, false, current_last_ordinal, true);
    }
    if last < first || last <= current_last_ordinal.0 {
        return outcome(current, false, current_last_ordinal, false);
    }
    if first > current_last_ordinal.0 + 1.0 {
        return outcome(current, false, current_last_ordinal, true);
    }
    let length = current.len();
    current.extend(
        append
            .messages
            .iter()
            .filter(|entry| entry.ordinal.0 > current_last_ordinal.0)
            .cloned(),
    );
    let changed = current.len() != length;
    outcome(current, changed, append.last_ordinal, false)
}
