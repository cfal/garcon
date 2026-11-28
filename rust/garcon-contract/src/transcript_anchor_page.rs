//! Ports `common/transcript-anchor-page.ts`.

use garcon_js::{is_safe_integer, json::as_number, trim};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::async_user_questions::InvalidAsyncQuestionReply;
use crate::chat_types::ChatMessage;
use crate::chat_view::{
    ChatHistoryResponse, ChatHistoryState, ChatMessagesRequest, InvalidHistoryPage,
    ResendCandidate, TranscriptMessage, TranscriptPage, TranscriptReadPurpose,
    UnavailableChatHistoryResponse, parse_chat_history_response, parse_chat_history_state,
    parse_resend_candidates, parse_transcript_messages,
};

pub const TRANSCRIPT_ANCHOR_TARGET: u64 = 100;
pub const TRANSCRIPT_ANCHOR_MAX_BUDGET: u64 = 200;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptAnchorDirection {
    Backward,
    Forward,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptAnchorPageStatus {
    Partial,
    Complete,
    Exhausted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptAnchorRequest {
    pub chat_id: String,
    pub direction: TranscriptAnchorDirection,
    pub anchors_remaining: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_view_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_ordinal: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub watermark_ordinal: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub purpose: Option<TranscriptReadPurpose>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptAnchorPage {
    pub history_state: ChatHistoryState,
    pub chat_id: String,
    pub transcript_view_id: String,
    pub direction: TranscriptAnchorDirection,
    pub watermark_ordinal: u64,
    pub last_ordinal: u64,
    pub start_ordinal: u64,
    pub end_ordinal: u64,
    pub anchors_remaining: u64,
    pub page_status: TranscriptAnchorPageStatus,
    pub messages: Vec<TranscriptMessage>,
    pub resend_candidates: Vec<ResendCandidate>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum TranscriptAnchorResponse {
    Complete(TranscriptAnchorPage),
    Unavailable(UnavailableChatHistoryResponse),
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Invalid combined history request: {0}")]
pub struct TranscriptAnchorRequestError(&'static str);

pub fn is_transcript_anchor(message: &ChatMessage) -> bool {
    matches!(message, ChatMessage::User(_) | ChatMessage::Assistant(_))
}

pub fn parse_transcript_anchor_request(
    value: &Value,
) -> Result<TranscriptAnchorRequest, TranscriptAnchorRequestError> {
    use TranscriptAnchorDirection::{Backward, Forward};
    use TranscriptAnchorRequestError as Invalid;
    let raw = value.as_object().ok_or(Invalid("expected an object"))?;
    let chat_id = string(&value["chatId"]).ok_or(Invalid("chatId"))?;
    let direction = match value["direction"].as_str() {
        Some("backward") => Backward,
        Some("forward") => Forward,
        _ => return Err(Invalid("direction")),
    };
    let anchors_remaining =
        integer(&value["anchorsRemaining"]).ok_or(Invalid("anchorsRemaining"))?;
    if anchors_remaining > TRANSCRIPT_ANCHOR_MAX_BUDGET {
        return Err(Invalid("anchor budget exceeds maximum"));
    }
    let transcript_view_id = raw
        .get("transcriptViewId")
        .map(|value| string(value).ok_or(Invalid("transcriptViewId")))
        .transpose()?;
    let cursor_ordinal = raw
        .get("cursorOrdinal")
        .map(|value| integer(value).ok_or(Invalid("cursorOrdinal")))
        .transpose()?;
    let watermark_ordinal = raw
        .get("watermarkOrdinal")
        .map(|value| integer(value).ok_or(Invalid("watermarkOrdinal")))
        .transpose()?;
    if cursor_ordinal.is_some() && transcript_view_id.is_none() {
        return Err(Invalid("cursor requires a view"));
    }
    if direction == Backward && cursor_ordinal == Some(0) {
        return Err(Invalid("backward cursor must be positive"));
    }
    if let Some(watermark) = watermark_ordinal {
        let cursor = cursor_ordinal
            .filter(|_| transcript_view_id.is_some())
            .ok_or(Invalid("watermark requires a view and cursor"))?;
        if watermark == MAX_SAFE_INTEGER {
            return Err(Invalid("watermark exceeds maximum"));
        }
        if cursor > watermark + u64::from(direction == Backward) {
            return Err(Invalid("cursor exceeds watermark"));
        }
    } else if anchors_remaining == 0 {
        return Err(Invalid("zero budget requires a continuation"));
    }
    let purpose = match raw.get("purpose") {
        None => None,
        Some(purpose)
            if purpose == "activation"
                && direction == Backward
                && cursor_ordinal.is_none()
                && watermark_ordinal.is_none() =>
        {
            Some(TranscriptReadPurpose::Activation)
        }
        Some(_) => return Err(Invalid("activation requires initial backward history")),
    };
    Ok(TranscriptAnchorRequest {
        chat_id,
        direction,
        anchors_remaining,
        transcript_view_id,
        cursor_ordinal,
        watermark_ordinal,
        purpose,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum InvalidAnchorPage {
    #[error("Invalid combined history page: {0}")]
    Field(String),
    #[error(transparent)]
    History(#[from] InvalidHistoryPage),
    #[error(transparent)]
    Message(#[from] InvalidAsyncQuestionReply),
}

impl InvalidAnchorPage {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Field(_) => "Error",
            Self::History(error) => error.name(),
            Self::Message(_) => "TypeError",
        }
    }
}

pub fn is_complete_transcript_anchor_response(response: &TranscriptAnchorResponse) -> bool {
    matches!(response, TranscriptAnchorResponse::Complete(_))
}

pub fn parse_transcript_anchor_response(
    request: &TranscriptAnchorRequest,
    value: &Value,
) -> Result<TranscriptAnchorResponse, InvalidAnchorPage> {
    use TranscriptAnchorDirection::{Backward, Forward};
    use TranscriptAnchorPageStatus::{Complete, Exhausted, Partial};
    let raw = value
        .as_object()
        .ok_or_else(|| invalid("expected an object"))?;
    let history_state =
        parse_chat_history_state(&value["historyState"]).ok_or_else(|| invalid("historyState"))?;
    if history_state != ChatHistoryState::Complete {
        for field in [
            "direction",
            "watermarkOrdinal",
            "startOrdinal",
            "endOrdinal",
            "anchorsRemaining",
            "pageStatus",
            "resendCandidates",
        ] {
            if raw.contains_key(field) {
                return Err(invalid(format!("unavailable {field}")));
            }
        }
        let request = ChatMessagesRequest {
            chat_id: request.chat_id.clone(),
            limit: None,
            before_ordinal: None,
            transcript_view_id: None,
            purpose: None,
        };
        let ChatHistoryResponse::Unavailable(unavailable) =
            parse_chat_history_response(&request, value)?
        else {
            return Err(invalid("unavailable history"));
        };
        return Ok(TranscriptAnchorResponse::Unavailable(unavailable));
    }
    let messages = parse_transcript_messages(&value["messages"])?;
    let resend_candidates = parse_resend_candidates(&value["resendCandidates"]);
    let (Some(messages), Some(resend_candidates)) = (messages, resend_candidates) else {
        return Err(invalid("messages or resendCandidates"));
    };
    let direction = request.direction;
    let expected_direction = if direction == Backward {
        "backward"
    } else {
        "forward"
    };
    if value["direction"] != expected_direction {
        return Err(invalid("direction does not match request"));
    }
    let page_status = match value["pageStatus"].as_str() {
        Some("partial") => Partial,
        Some("complete") => Complete,
        Some("exhausted") => Exhausted,
        _ => return Err(invalid("pageStatus")),
    };
    let field_integer = |field: &str| integer(&value[field]).ok_or_else(|| invalid(field));
    let page = TranscriptAnchorPage {
        history_state,
        chat_id: string(&value["chatId"]).ok_or_else(|| invalid("chatId"))?,
        transcript_view_id: string(&value["transcriptViewId"])
            .ok_or_else(|| invalid("transcriptViewId"))?,
        direction,
        watermark_ordinal: field_integer("watermarkOrdinal")?,
        last_ordinal: field_integer("lastOrdinal")?,
        start_ordinal: field_integer("startOrdinal")?,
        end_ordinal: field_integer("endOrdinal")?,
        anchors_remaining: field_integer("anchorsRemaining")?,
        page_status,
        messages,
        resend_candidates,
    };
    if page.chat_id != request.chat_id
        || request
            .transcript_view_id
            .as_ref()
            .is_some_and(|view| *view != page.transcript_view_id)
    {
        return Err(invalid("identity does not match request"));
    }
    let watermark = page.watermark_ordinal;
    if watermark != request.watermark_ordinal.unwrap_or(page.last_ordinal)
        || watermark > page.last_ordinal
        || page.last_ordinal == MAX_SAFE_INTEGER
    {
        return Err(invalid("watermark"));
    }
    let cursor = request.cursor_ordinal.unwrap_or(if direction == Backward {
        watermark + 1
    } else {
        0
    });
    let width = page
        .end_ordinal
        .checked_sub(page.start_ordinal)
        .filter(|_| page.start_ordinal >= 1 && page.end_ordinal <= watermark + 1)
        .ok_or_else(|| invalid("raw span"))?;
    let cursor_contiguous = if direction == Backward {
        page.end_ordinal == cursor
    } else {
        page.start_ordinal.checked_sub(1) == Some(cursor)
    };
    if !cursor_contiguous {
        return Err(invalid("cursor contiguity"));
    }
    if page.messages.len() as u64 > width
        || page.messages.iter().any(|entry| {
            entry.ordinal.0 < page.start_ordinal as f64
                || entry.ordinal.0 >= page.end_ordinal as f64
        })
    {
        return Err(invalid("message outside raw span"));
    }
    let anchors = page
        .messages
        .iter()
        .filter(|entry| is_transcript_anchor(&entry.message))
        .count() as u64;
    if request.anchors_remaining.checked_sub(anchors) != Some(page.anchors_remaining) {
        return Err(invalid("anchor budget"));
    }
    let at_edge = if direction == Backward {
        page.start_ordinal == 1
    } else {
        page.end_ordinal == watermark + 1
    };
    if (page_status == Exhausted) != at_edge {
        return Err(invalid("exhaustion"));
    }
    if page_status == Complete
        && (page.anchors_remaining != 0 || (width == 0 && request.anchors_remaining != 0))
    {
        return Err(invalid("completion"));
    }
    if page_status == Partial && width == 0 {
        return Err(invalid("partial must make progress"));
    }
    if (direction == Forward || request.cursor_ordinal.is_some())
        && !page.resend_candidates.is_empty()
    {
        return Err(invalid("resend candidates on continuation"));
    }
    Ok(TranscriptAnchorResponse::Complete(page))
}

pub fn transcript_anchor_cursor(page: &TranscriptAnchorPage) -> u64 {
    match page.direction {
        TranscriptAnchorDirection::Backward => page.start_ordinal,
        TranscriptAnchorDirection::Forward => page.end_ordinal.saturating_sub(1),
    }
}

pub fn transcript_anchor_continuation(
    page: &TranscriptAnchorPage,
) -> Option<TranscriptAnchorRequest> {
    (page.page_status == TranscriptAnchorPageStatus::Partial).then(|| TranscriptAnchorRequest {
        chat_id: page.chat_id.clone(),
        direction: page.direction,
        anchors_remaining: page.anchors_remaining,
        transcript_view_id: Some(page.transcript_view_id.clone()),
        cursor_ordinal: Some(transcript_anchor_cursor(page)),
        watermark_ordinal: Some(page.watermark_ordinal),
        purpose: None,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("Empty terminal anchor chunks do not describe a transcript window")]
pub struct EmptyAnchorWindow;

pub fn transcript_anchor_window(
    page: &TranscriptAnchorPage,
) -> Result<TranscriptPage, EmptyAnchorWindow> {
    if page.start_ordinal == page.end_ordinal && page.watermark_ordinal != 0 {
        return Err(EmptyAnchorWindow);
    }
    let next_before_ordinal = (page.start_ordinal > 1).then_some(page.start_ordinal);
    Ok(TranscriptPage {
        transcript_view_id: page.transcript_view_id.clone(),
        messages: page.messages.clone(),
        last_ordinal: page.last_ordinal,
        page_oldest_ordinal: page
            .messages
            .first()
            .map_or(0, |entry| entry.ordinal.0 as u64),
        page_newest_ordinal: page.end_ordinal.saturating_sub(1),
        next_before_ordinal,
        has_more: next_before_ordinal.is_some(),
    })
}

fn invalid(reason: impl Into<String>) -> InvalidAnchorPage {
    InvalidAnchorPage::Field(reason.into())
}

fn integer(value: &Value) -> Option<u64> {
    as_number(value)
        .filter(|&n| is_safe_integer(n) && n >= 0.0)
        .map(|n| n as u64)
}

fn string(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|s| !trim(s).is_empty())
        .map(str::to_owned)
}
