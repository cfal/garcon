//! Ports common/chat-row-contracts.ts.

use garcon_js::{is_safe_integer, trim};
use serde::Serialize;
use serde_json::Value;

use crate::chat_id::ChatId;
use crate::cli_presentation::{
    CliBodyDisclosure, CliPresentation, CliRowFormat, is_cli_body_disclosure, is_cli_presentation,
    is_cli_row_format,
};
use crate::command_request_validation::{
    CommandRequestValidationError, request_record, required_chat_id,
    required_command_correlation_id, required_string,
};

pub const CHAT_ROW_CONTENT_MAX_BYTES: usize = 64 * 1024;
pub const CHAT_ROW_TITLE_MAX_CODE_POINTS: usize = 120;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRowTargetResponse {
    pub success: bool,
    pub chat_id: String,
    pub transcript_view_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddChatRowRequest {
    pub client_request_id: String,
    pub client_message_id: String,
    pub chat_id: ChatId,
    pub transcript_view_id: String,
    pub presentation: CliPresentation,
    pub format: CliRowFormat,
    pub disclosure: CliBodyDisclosure,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddChatRowResponse {
    pub success: bool,
    pub command_type: ChatRowCommandType,
    pub client_request_id: String,
    pub client_message_id: String,
    pub chat_id: String,
    pub transcript_view_id: String,
    pub ordinal: u64,
    pub presentation: CliPresentation,
    pub format: CliRowFormat,
    pub disclosure: CliBodyDisclosure,
    pub status: AddChatRowStatus,
    pub timestamp: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChatRowCommandType {
    ChatRowAdd,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AddChatRowStatus {
    Appended,
    Duplicate,
}

pub fn parse_chat_row_content(value: &Value) -> Result<&str, CommandRequestValidationError> {
    parse_content(value, false)
}

fn parse_content(value: &Value, unpaired: bool) -> Result<&str, CommandRequestValidationError> {
    let content = value
        .as_str()
        .filter(|value| !trim(value).is_empty())
        .ok_or_else(|| CommandRequestValidationError::new("content is required"))?;
    if unpaired {
        return Err(CommandRequestValidationError::new(
            "content must contain well-formed Unicode",
        ));
    }
    if content.len() > CHAT_ROW_CONTENT_MAX_BYTES {
        return Err(CommandRequestValidationError::new(format!(
            "content must be at most {CHAT_ROW_CONTENT_MAX_BYTES} UTF-8 bytes"
        )));
    }
    Ok(content)
}

pub fn parse_chat_row_title(value: &Value) -> Result<Option<&str>, CommandRequestValidationError> {
    parse_title(value, false)
}

fn parse_title(
    value: &Value,
    unpaired: bool,
) -> Result<Option<&str>, CommandRequestValidationError> {
    if value.is_null() {
        return Ok(None);
    }
    let title = trim(
        value
            .as_str()
            .ok_or_else(|| CommandRequestValidationError::new("title must be a string"))?,
    );
    if title.is_empty() {
        return Err(CommandRequestValidationError::new(
            "title must not be empty",
        ));
    }
    if unpaired {
        return Err(CommandRequestValidationError::new(
            "title must contain well-formed Unicode",
        ));
    }
    if title
        .chars()
        .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}'))
    {
        return Err(CommandRequestValidationError::new(
            "title must be a single line",
        ));
    }
    if title.chars().count() > CHAT_ROW_TITLE_MAX_CODE_POINTS {
        return Err(CommandRequestValidationError::new(format!(
            "title must be at most {CHAT_ROW_TITLE_MAX_CODE_POINTS} characters"
        )));
    }
    Ok(Some(title))
}

pub fn parse_add_chat_row_request(
    value: &Value,
) -> Result<AddChatRowRequest, CommandRequestValidationError> {
    parse_add_chat_row_request_with_unpaired_surrogates(value, ChatRowUnpairedSurrogates::default())
}

#[derive(Debug, Default, Clone, Copy)]
pub struct ChatRowUnpairedSurrogates {
    pub title: bool,
    pub content: bool,
}

pub fn parse_add_chat_row_request_with_unpaired_surrogates(
    value: &Value,
    unpaired: ChatRowUnpairedSurrogates,
) -> Result<AddChatRowRequest, CommandRequestValidationError> {
    let body = request_record(value)?;
    let presentation = body
        .get("presentation")
        .and_then(is_cli_presentation)
        .ok_or_else(|| CommandRequestValidationError::new("presentation is invalid"))?;
    let format = body
        .get("format")
        .and_then(is_cli_row_format)
        .ok_or_else(|| CommandRequestValidationError::new("format must be plain or markdown"))?;
    let disclosure = body
        .get("disclosure")
        .and_then(is_cli_body_disclosure)
        .ok_or_else(|| {
            CommandRequestValidationError::new("disclosure must be expanded or collapsed")
        })?;
    let title = parse_title(body.get("title").unwrap_or(&Value::Null), unpaired.title)?;
    Ok(AddChatRowRequest {
        client_request_id: required_command_correlation_id(body, "clientRequestId")?.to_owned(),
        client_message_id: required_command_correlation_id(body, "clientMessageId")?.to_owned(),
        chat_id: required_chat_id(body, "chatId")?,
        transcript_view_id: required_string(body, "transcriptViewId")?.to_owned(),
        presentation,
        format,
        disclosure,
        title: title.map(str::to_owned),
        content: parse_content(
            body.get("content").unwrap_or(&Value::Null),
            unpaired.content,
        )?
        .to_owned(),
    })
}

fn nonempty_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

pub fn parse_chat_row_target_response(value: &Value) -> Option<ChatRowTargetResponse> {
    let raw = value.as_object()?;
    if raw.get("success")?.as_bool() != Some(true) {
        return None;
    }
    Some(ChatRowTargetResponse {
        success: true,
        chat_id: nonempty_string(raw.get("chatId")?)?,
        transcript_view_id: nonempty_string(raw.get("transcriptViewId")?)?,
    })
}

pub fn parse_add_chat_row_response(value: &Value) -> Option<AddChatRowResponse> {
    let raw = value.as_object()?;
    if raw.get("success")?.as_bool() != Some(true)
        || raw.get("commandType")?.as_str()? != "chat-row-add"
    {
        return None;
    }
    let client_request_id = nonempty_string(raw.get("clientRequestId")?)?;
    let client_message_id = nonempty_string(raw.get("clientMessageId")?)?;
    let chat_id = nonempty_string(raw.get("chatId")?)?;
    let transcript_view_id = nonempty_string(raw.get("transcriptViewId")?)?;
    let ordinal = raw.get("ordinal")?.as_f64()?;
    if !is_safe_integer(ordinal) || ordinal < 1.0 {
        return None;
    }
    let presentation = is_cli_presentation(raw.get("presentation")?)?;
    let format = is_cli_row_format(raw.get("format")?)?;
    let disclosure = is_cli_body_disclosure(raw.get("disclosure")?)?;
    let status = match raw.get("status")?.as_str()? {
        "appended" => AddChatRowStatus::Appended,
        "duplicate" => AddChatRowStatus::Duplicate,
        _ => return None,
    };
    Some(AddChatRowResponse {
        success: true,
        command_type: ChatRowCommandType::ChatRowAdd,
        client_request_id,
        client_message_id,
        chat_id,
        transcript_view_id,
        ordinal: ordinal as u64,
        presentation,
        format,
        disclosure,
        status,
        timestamp: nonempty_string(raw.get("timestamp")?)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request() -> Value {
        json!({
            "clientRequestId":"request-1","clientMessageId":"message-1","chatId":"1787000000000000",
            "transcriptViewId":"view-1","presentation":{"style":"notice"},"format":"plain",
            "disclosure":"expanded","content":"  retained exactly\n"
        })
    }

    #[test]
    fn parses_every_chat_row_style_without_trimming_content() {
        let mut input = request();
        for presentation in [
            json!({"style":"notice"}),
            json!({"style":"info"}),
            json!({"style":"error"}),
            json!({"style":"custom","customStyle":{"lightAccent":"#7c3aed","darkAccent":"#c4b5fd"}}),
        ] {
            input["presentation"] = presentation;
            assert_eq!(json!(parse_add_chat_row_request(&input).unwrap()), input);
        }
    }

    #[test]
    fn canonicalizes_optional_titles_without_changing_row_content() {
        let mut input = request();
        input["title"] = json!("  Release   validation  ");
        let parsed = parse_add_chat_row_request(&input).unwrap();
        assert_eq!(parsed.title.as_deref(), Some("Release   validation"));
        assert_eq!(parsed.content, "  retained exactly\n");
        input["title"] = Value::Null;
        assert_eq!(
            json!(parse_add_chat_row_request(&input).unwrap()),
            request()
        );
        assert_eq!(
            parse_chat_row_title(&json!("Deployment")),
            Ok(Some("Deployment"))
        );
    }

    #[test]
    fn enforces_the_single_line_title_boundary_in_unicode_code_points() {
        let valid = "\u{1f680}".repeat(CHAT_ROW_TITLE_MAX_CODE_POINTS);
        assert_eq!(
            parse_chat_row_title(&json!(valid)),
            Ok(Some(valid.as_str()))
        );
        for too_long in ["x", "\u{1f680}"] {
            assert_eq!(
                parse_chat_row_title(&json!(too_long.repeat(121))),
                Err(CommandRequestValidationError::new(
                    "title must be at most 120 characters"
                ))
            );
        }
        assert_eq!(
            parse_chat_row_title(&json!(" \t ")),
            Err(CommandRequestValidationError::new(
                "title must not be empty"
            ))
        );
        for separator in ['\n', '\u{2028}', '\u{2029}', '\u{0085}'] {
            assert_eq!(
                parse_chat_row_title(&json!(format!("first{separator}second"))),
                Err(CommandRequestValidationError::new(
                    "title must be a single line"
                ))
            );
        }
        assert_eq!(
            parse_chat_row_title(&json!(42)),
            Err(CommandRequestValidationError::new("title must be a string"))
        );
        assert_eq!(
            parse_chat_row_title(&json!("\u{fffd}")),
            Ok(Some("\u{fffd}"))
        );
    }

    #[test]
    fn enforces_the_utf_8_content_boundary_and_well_formed_unicode() {
        let at_limit = "x".repeat(CHAT_ROW_CONTENT_MAX_BYTES);
        assert_eq!(
            parse_chat_row_content(&json!(at_limit)).unwrap().len(),
            CHAT_ROW_CONTENT_MAX_BYTES
        );
        for content in [
            "x".repeat(CHAT_ROW_CONTENT_MAX_BYTES + 1),
            "\u{e9}".repeat(CHAT_ROW_CONTENT_MAX_BYTES / 2 + 1),
        ] {
            assert_eq!(
                parse_chat_row_content(&json!(content)),
                Err(CommandRequestValidationError::new(
                    "content must be at most 65536 UTF-8 bytes"
                ))
            );
        }
        assert_eq!(
            parse_chat_row_content(&json!(" \n\t ")),
            Err(CommandRequestValidationError::new("content is required"))
        );
        assert_eq!(parse_chat_row_content(&json!("\u{fffd}")), Ok("\u{fffd}"));
    }

    #[test]
    fn rejects_invalid_presentations_and_formats_in_order() {
        let mut input = request();
        input["title"] = json!(42);
        input["disclosure"] = json!("hidden");
        input["format"] = json!("html");
        input["presentation"] = json!({"style":"custom"});
        for (key, valid, message) in [
            (
                "presentation",
                json!({"style":"notice"}),
                "presentation is invalid",
            ),
            ("format", json!("plain"), "format must be plain or markdown"),
            (
                "disclosure",
                json!("expanded"),
                "disclosure must be expanded or collapsed",
            ),
            ("title", Value::Null, "title must be a string"),
        ] {
            assert_eq!(
                parse_add_chat_row_request(&input),
                Err(CommandRequestValidationError::new(message))
            );
            input[key] = valid;
        }
        assert!(parse_add_chat_row_request(&input).is_ok());
    }

    #[test]
    fn durable_request_rejects_surrogates_without_changing_validation_order() {
        let mut body = request();
        body["title"] = json!("\u{fffd}\nsecond");
        body["content"] = json!("\u{fffd}");
        let mut unpaired = ChatRowUnpairedSurrogates {
            title: true,
            content: true,
        };
        body["format"] = json!("html");
        let validate = |body: &Value, unpaired| {
            parse_add_chat_row_request_with_unpaired_surrogates(body, unpaired)
                .unwrap_err()
                .to_string()
        };
        assert_eq!(
            validate(&body, unpaired),
            "format must be plain or markdown"
        );
        body["format"] = json!("plain");
        assert_eq!(
            validate(&body, unpaired),
            "title must contain well-formed Unicode"
        );
        unpaired.title = false;
        assert_eq!(validate(&body, unpaired), "title must be a single line");
        body["title"] = json!("\u{fffd}");
        body["clientRequestId"] = Value::Null;
        assert_eq!(validate(&body, unpaired), "clientRequestId is required");
        body["clientRequestId"] = json!("request-1");
        assert_eq!(
            validate(&body, unpaired),
            "content must contain well-formed Unicode"
        );
        let accepted = parse_add_chat_row_request(&body).unwrap();
        assert_eq!(accepted.title.as_deref(), Some("\u{fffd}"));
        assert_eq!(accepted.content, "\u{fffd}");
    }

    #[test]
    fn parses_target_and_mutation_responses_strictly() {
        let mut target =
            json!({"success":true,"chatId":"1787000000000000","transcriptViewId":"view-1"});
        assert_eq!(json!(parse_chat_row_target_response(&target)), target);
        target["chatId"] = json!("");
        assert_eq!(parse_chat_row_target_response(&target), None);
        let response = json!({"success":true,"commandType":"chat-row-add","clientRequestId":"request-1",
            "clientMessageId":"message-1","chatId":"1787000000000000","transcriptViewId":"view-1",
            "ordinal":7,"presentation":{"style":"info"},"format":"markdown","disclosure":"collapsed",
            "status":"duplicate","timestamp":"2026-08-18T00:00:00.000Z"});
        assert_eq!(json!(parse_add_chat_row_response(&response)), response);
        for (key, bad) in [
            ("ordinal", json!(0)),
            ("ordinal", json!(9_007_199_254_740_992_u64)),
            ("status", json!("accepted")),
            ("commandType", json!("agent-run")),
        ] {
            let mut invalid = response.clone();
            invalid[key] = bad;
            assert_eq!(parse_add_chat_row_response(&invalid), None);
        }
    }
}
