use std::sync::LazyLock;

use garcon_js::{Number, json::as_number, parse_int, trim};
use serde::{Deserialize, Serialize, Serializer, ser::SerializeMap};
use serde_json::{Map, Value};

use crate::async_user_questions::{
    AsyncQuestionReply, InvalidAsyncQuestionReply, parse_async_question_reply,
};
use crate::chat_types::CodexSubagentInputItem;
use crate::input_format::InputFormat;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatImage {
    pub data: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatContentMode {
    Literal,
}

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageMetadata {
    pub content_mode: Option<ChatContentMode>,
    pub content_format: Option<InputFormat>,
    pub client_request_id: Option<String>,
    pub client_message_id: Option<String>,
    pub upstream_request_id: Option<String>,
    pub turn_id: Option<String>,
    pub question_reply: Option<AsyncQuestionReply>,
    #[serde(skip)]
    stamped_id_last: bool,
}

impl ChatMessageMetadata {
    pub fn stamp_client_message_id(&mut self, id: String) {
        // The original spread appends a new key and overwrites an existing key in place.
        self.stamped_id_last |= self.client_message_id.is_none();
        self.client_message_id = Some(id);
    }
}

impl PartialEq for ChatMessageMetadata {
    fn eq(&self, other: &Self) -> bool {
        self.content_mode == other.content_mode
            && self.content_format == other.content_format
            && self.client_request_id == other.client_request_id
            && self.client_message_id == other.client_message_id
            && self.upstream_request_id == other.upstream_request_id
            && self.turn_id == other.turn_id
            && self.question_reply == other.question_reply
    }
}

impl Serialize for ChatMessageMetadata {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut fields = serializer.serialize_map(None)?;
        macro_rules! optional {
            ($name:literal, $field:ident) => {
                if let Some(value) = &self.$field {
                    fields.serialize_entry($name, value)?;
                }
            };
        }
        optional!("contentMode", content_mode);
        optional!("contentFormat", content_format);
        optional!("clientRequestId", client_request_id);
        if !self.stamped_id_last {
            optional!("clientMessageId", client_message_id);
        }
        optional!("upstreamRequestId", upstream_request_id);
        optional!("turnId", turn_id);
        optional!("questionReply", question_reply);
        if self.stamped_id_last {
            optional!("clientMessageId", client_message_id);
        }
        fields.end()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskUserQuestionOption {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskUserQuestionPrompt {
    pub id: String,
    pub prompt: String,
    pub options: Vec<AskUserQuestionOption>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_multiple: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_free_text: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_notes: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_secret: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AllowedPrompt {
    pub tool: String,
    pub prompt: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OptionalChange {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

pub fn as_codex_subagent_input_items(value: &Value) -> Option<Vec<CodexSubagentInputItem>> {
    optional_items(value, |entry| {
        let raw = as_record(entry);
        let item = CodexSubagentInputItem {
            input_type: field(raw, "type"),
            text: field(raw, "text"),
            image_url: field(raw, "imageUrl"),
            path: field(raw, "path"),
            name: field(raw, "name"),
        };
        (item.input_type.is_some()
            || item.text.is_some()
            || item.image_url.is_some()
            || item.path.is_some()
            || item.name.is_some())
        .then_some(item)
    })
}

pub fn str(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

pub fn as_optional_string(value: &Value) -> Option<&str> {
    value.as_str()
}

pub fn as_optional_string_array(value: &Value) -> Option<Vec<String>> {
    Some(
        value
            .as_array()?
            .iter()
            .filter_map(|value| as_optional_string(value).map(str::to_owned))
            .collect(),
    )
}

pub fn as_optional_number(value: &Value) -> Option<Number> {
    let number = if let Some(number) = as_number(value) {
        number
    } else {
        finite_number_string(value.as_str()?)?
    };
    number.is_finite().then_some(Number(number))
}

fn finite_number_string(value: &str) -> Option<f64> {
    let value = trim(value);
    if value.is_empty() {
        return Some(0.0);
    }
    let radix = match value.as_bytes().get(..2) {
        Some(b"0x" | b"0X") => Some(16),
        Some(b"0o" | b"0O") => Some(8),
        Some(b"0b" | b"0B") => Some(2),
        _ => None,
    };
    if let Some(radix) = radix {
        let digits = &value[2..];
        if digits.is_empty() || !digits.chars().all(|digit| digit.is_digit(radix)) {
            return None;
        }
        return parse_int(digits, radix);
    }
    if !value
        .bytes()
        .all(|byte| matches!(byte, b'0'..=b'9' | b'+' | b'-' | b'.' | b'e' | b'E'))
    {
        return None;
    }
    value.parse().ok()
}

pub fn as_record(value: &Value) -> &Map<String, Value> {
    static EMPTY: LazyLock<Map<String, Value>> = LazyLock::new(Map::new);
    value.as_object().unwrap_or(&EMPTY)
}

pub fn parse_chat_message_metadata(
    value: &Value,
) -> Result<Option<ChatMessageMetadata>, InvalidAsyncQuestionReply> {
    let raw = as_record(value);
    let content_mode = (raw.get("contentMode").and_then(Value::as_str) == Some("literal"))
        .then_some(ChatContentMode::Literal);
    let content_format = match raw.get("contentFormat").and_then(Value::as_str) {
        Some("plain") => Some(InputFormat::Plain),
        Some("markdown") => Some(InputFormat::Markdown),
        _ => None,
    };
    let client_request_id = field(raw, "clientRequestId");
    let client_message_id = field(raw, "clientMessageId");
    let upstream_request_id = field(raw, "upstreamRequestId");
    let turn_id = field(raw, "turnId");
    let question_reply = parse_async_question_reply(raw.get("questionReply"))?;
    Ok((content_mode.is_some()
        || content_format.is_some()
        || client_request_id.is_some()
        || client_message_id.is_some()
        || upstream_request_id.is_some()
        || turn_id.is_some()
        || question_reply.is_some())
    .then_some(ChatMessageMetadata {
        content_mode,
        content_format,
        client_request_id,
        client_message_id,
        upstream_request_id,
        turn_id,
        question_reply,
        stamped_id_last: false,
    }))
}

pub fn as_string_array(value: &Value) -> Option<Vec<String>> {
    let strings: Vec<_> = value
        .as_array()?
        .iter()
        .filter_map(|value| {
            value
                .as_str()
                .filter(|item| !trim(item).is_empty())
                .map(str::to_owned)
        })
        .collect();
    (!strings.is_empty()).then_some(strings)
}

pub fn as_chat_images(value: &Value) -> Option<Vec<ChatImage>> {
    optional_items(value, |item| {
        let raw = as_record(item);
        Some(ChatImage {
            data: field(raw, "data")?,
            name: field(raw, "name")?,
            mime_type: field(raw, "mimeType").filter(|mime_type| !mime_type.is_empty()),
        })
    })
}

pub fn as_allowed_prompts(value: &Value) -> Option<Vec<AllowedPrompt>> {
    optional_items(value, |item| {
        let raw = as_record(item);
        Some(AllowedPrompt {
            tool: field(raw, "tool")?,
            prompt: field(raw, "prompt")?,
        })
    })
}

pub fn as_optional_boolean(value: &Value) -> Option<bool> {
    value.as_bool()
}

fn as_ask_user_question_options(value: Option<&Value>) -> Vec<AskUserQuestionOption> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let raw = as_record(item);
            Some(AskUserQuestionOption {
                id: field(raw, "id")?,
                label: field(raw, "label")?,
                description: field(raw, "description"),
                preview: field(raw, "preview"),
            })
        })
        .collect()
}

pub fn as_ask_user_questions(value: &Value) -> Vec<AskUserQuestionPrompt> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let raw = as_record(item);
            Some(AskUserQuestionPrompt {
                id: field(raw, "id")?,
                prompt: field(raw, "prompt")?,
                options: as_ask_user_question_options(raw.get("options")),
                header: field(raw, "header"),
                allow_multiple: raw.get("allowMultiple").and_then(as_optional_boolean),
                allow_free_text: raw.get("allowFreeText").and_then(as_optional_boolean),
                allow_notes: raw.get("allowNotes").and_then(as_optional_boolean),
                is_secret: raw.get("isSecret").and_then(as_optional_boolean),
            })
        })
        .collect()
}

pub fn as_optional_changes(value: &Value) -> Option<Vec<OptionalChange>> {
    optional_items(value, |item| {
        let raw = as_record(item);
        let path = field(raw, "path");
        let kind = field(raw, "kind");
        (path.is_some() || kind.is_some()).then_some(OptionalChange { path, kind })
    })
}

fn field(raw: &Map<String, Value>, key: &str) -> Option<String> {
    raw.get(key).and_then(as_optional_string).map(str::to_owned)
}

fn optional_items<T>(value: &Value, parse: impl FnMut(&Value) -> Option<T>) -> Option<Vec<T>> {
    let array = value.as_array()?;
    let items: Vec<_> = array.iter().filter_map(parse).collect();
    (!items.is_empty() || array.is_empty()).then_some(items)
}
