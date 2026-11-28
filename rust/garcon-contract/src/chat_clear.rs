//! Ports `common/chat-clear.ts`.

use garcon_js::{is_safe_integer, json::as_number};
use serde::Serialize;
use serde_json::Value;

use crate::chat_id::ChatId;
use crate::command_request_validation::{
    CommandRequestValidationError, request_record, required_chat_id, required_string,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearChatRequest {
    pub chat_id: ChatId,
    pub transcript_view_id: String,
    pub last_ordinal: u64,
    pub target: ClearChatTarget,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ClearChatTarget {
    All,
    BeforeMessage { ordinal: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearChatResponse {
    pub success: bool,
    pub chat_id: ChatId,
    pub transcript_view_id: String,
}

pub fn parse_clear_chat_request(
    value: &Value,
) -> Result<ClearChatRequest, CommandRequestValidationError> {
    let body = request_record(value)?;
    let last_ordinal = as_number(&value["lastOrdinal"])
        .filter(|&n| is_safe_integer(n) && n >= 0.0)
        .ok_or_else(|| {
            CommandRequestValidationError::new("lastOrdinal must be a nonnegative integer")
        })? as u64;
    let target = &value["target"];
    let fields = request_record(target)?;
    let invalid = || CommandRequestValidationError::new("A valid clear target is required");
    let target = match target["kind"].as_str() {
        Some("all") if fields.len() == 1 => ClearChatTarget::All,
        Some("before-message")
            if fields
                .keys()
                .all(|key| matches!(key.as_str(), "kind" | "ordinal")) =>
        {
            let ordinal = as_number(&target["ordinal"])
                .filter(|&n| is_safe_integer(n) && n >= 1.0 && n <= last_ordinal as f64)
                .ok_or_else(invalid)? as u64;
            ClearChatTarget::BeforeMessage { ordinal }
        }
        _ => return Err(invalid()),
    };
    Ok(ClearChatRequest {
        chat_id: required_chat_id(body, "chatId")?,
        transcript_view_id: required_string(body, "transcriptViewId")?.to_owned(),
        last_ordinal,
        target,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum InvalidClearChatResponse {
    #[error(transparent)]
    InvalidField(#[from] CommandRequestValidationError),
    #[error("Invalid clear chat response")]
    Unsuccessful,
}

impl InvalidClearChatResponse {
    pub fn name(&self) -> &'static str {
        match self {
            Self::InvalidField(_) => "CommandRequestValidationError",
            Self::Unsuccessful => "TypeError",
        }
    }
}

pub fn parse_clear_chat_response(
    value: &Value,
) -> Result<ClearChatResponse, InvalidClearChatResponse> {
    let body = request_record(value)?;
    if value["success"] != true {
        return Err(InvalidClearChatResponse::Unsuccessful);
    }
    Ok(ClearChatResponse {
        success: true,
        chat_id: required_chat_id(body, "chatId")?,
        transcript_view_id: required_string(body, "transcriptViewId")?.to_owned(),
    })
}
