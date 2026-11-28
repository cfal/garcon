//! Ports common/chat-title-contracts.ts.

use garcon_js::{trim, utf16};
use serde::Serialize;
use serde_json::Value;

pub const CHAT_TITLE_MAX_BYTES: usize = 4 * 1024;

pub fn is_chat_title_within_limit(title: &str) -> bool {
    utf16::len(title) <= CHAT_TITLE_MAX_BYTES && title.len() <= CHAT_TITLE_MAX_BYTES
}

pub fn fit_derived_chat_title(title: &str, suffix: &str) -> String {
    let available = CHAT_TITLE_MAX_BYTES.saturating_sub(suffix.len());
    let prefix_end = title.floor_char_boundary(available);
    let mut result = String::with_capacity(prefix_end + suffix.len());
    result.push_str(&title[..prefix_end]);
    result.push_str(suffix);
    result
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateChatTitleRequest {
    pub chat_id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateChatTitleResponse {
    pub success: bool,
    pub chat_id: String,
    pub title: String,
    pub changed: bool,
}

pub fn parse_update_chat_title_request(value: &Value) -> Option<UpdateChatTitleRequest> {
    let record = value.as_object()?;
    if !record
        .keys()
        .all(|key| matches!(key.as_str(), "chatId" | "title"))
    {
        return None;
    }
    let chat_id = trim(record.get("chatId")?.as_str()?);
    let title = trim(record.get("title")?.as_str()?);
    if chat_id.is_empty() || title.is_empty() || !is_chat_title_within_limit(title) {
        return None;
    }
    Some(UpdateChatTitleRequest {
        chat_id: chat_id.to_owned(),
        title: title.to_owned(),
    })
}

pub fn parse_update_chat_title_response(value: &Value) -> Option<UpdateChatTitleResponse> {
    let record = value.as_object()?;
    if !record
        .keys()
        .all(|key| matches!(key.as_str(), "success" | "chatId" | "title" | "changed"))
        || record.get("success")?.as_bool() != Some(true)
    {
        return None;
    }
    let chat_id = record.get("chatId")?.as_str()?;
    let title = record.get("title")?.as_str()?;
    let changed = record.get("changed")?.as_bool()?;
    if chat_id.is_empty() || title.is_empty() || trim(chat_id) != chat_id || trim(title) != title {
        return None;
    }
    Some(UpdateChatTitleResponse {
        success: true,
        chat_id: chat_id.to_owned(),
        title: title.to_owned(),
        changed,
    })
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateChatTitleRequest {
    pub chat_id: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_seq: Option<garcon_js::Number>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateChatTitleResponse {
    pub success: bool,
    pub chat_id: String,
    pub title: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GenerateChatTitleErrorCode {
    ValidationFailed,
    SessionNotFound,
    TitleGenerationUnavailable,
    TitleGenerationEmpty,
    TitleGenerationFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateChatTitleErrorResponse {
    pub success: bool,
    pub error: String,
    pub error_code: GenerateChatTitleErrorCode,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn chat_title_writes_enforce_a_utf_8_byte_bound_after_trimming() {
        for title in [
            "a".repeat(CHAT_TITLE_MAX_BYTES),
            "\u{1f600}".repeat(CHAT_TITLE_MAX_BYTES / 4),
        ] {
            let request = json!({"chatId":"synthetic","title":format!(" {title} ")});
            assert_eq!(
                parse_update_chat_title_request(&request),
                Some(UpdateChatTitleRequest {
                    chat_id: "synthetic".to_owned(),
                    title: title.clone()
                })
            );
            let request = json!({"chatId":"synthetic","title":format!("{title}x")});
            assert_eq!(parse_update_chat_title_request(&request), None);
        }
        assert_eq!(
            parse_update_chat_title_request(&json!({"chatId":"synthetic","title":" "})),
            None
        );
    }

    #[test]
    fn derived_titles_reserve_suffix_bytes_without_splitting_unicode_characters() {
        let title = fit_derived_chat_title(&"\u{1f600}".repeat(CHAT_TITLE_MAX_BYTES), " (123)");
        assert!(title.ends_with(" (123)"));
        assert!(title.len() <= CHAT_TITLE_MAX_BYTES);
        assert_eq!(
            title,
            format!(
                "{} (123)",
                "\u{1f600}".repeat((CHAT_TITLE_MAX_BYTES - 6) / 4)
            )
        );
    }

    #[test]
    fn normalizes_title_requests_and_validates_canonical_responses() {
        assert_eq!(
            json!(parse_update_chat_title_request(
                &json!({"chatId":" chat-a ","title":" New title "})
            )),
            json!({"chatId":"chat-a","title":"New title"})
        );
        let response =
            json!({"success":true,"chatId":"chat-a","title":"New title","changed":false});
        assert_eq!(json!(parse_update_chat_title_response(&response)), response);
    }

    #[test]
    fn rejects_malformed_title_contracts() {
        assert_eq!(
            parse_update_chat_title_request(&json!({"chatId":"chat-a"})),
            None
        );
        assert_eq!(
            parse_update_chat_title_request(&json!({"chatId":"chat-a","title":" ","extra":true})),
            None
        );
        assert_eq!(
            parse_update_chat_title_response(
                &json!({"success":true,"chatId":"chat-a","title":" New title ","changed":true})
            ),
            None
        );
    }
}
