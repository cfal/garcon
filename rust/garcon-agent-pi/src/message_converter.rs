//! Ports `server-agents/pi/src/agents/pi/message-converter.ts`.

use garcon_agents_common::shared::{
    file_mention_context::strip_resolved_file_mention_context,
    normalize_util::normalize_tool_result_content,
};
use garcon_contract::{
    chat_message_coercion::ChatImage,
    chat_types::{AssistantMessage, ChatMessage, ThinkingMessage, ToolResultMessage, UserMessage},
};
use garcon_interface::producer::AgentFinalResponse;
use garcon_js::{
    Clock, InvalidTimeValue,
    date_parse::date_parse,
    json::{Opaque, as_number},
    to_iso_string, trim,
};
use serde_json::Value;

use crate::tool_use_converter::convert_pi_tool_use;

pub fn pi_final_response(raw: &Value) -> Option<AgentFinalResponse> {
    if raw["role"].as_str() != Some("assistant")
        || !matches!(raw["stopReason"].as_str(), Some("stop" | "length"))
    {
        return None;
    }
    let content = &raw["content"];
    if let Some(text) = content.as_str() {
        return Some(AgentFinalResponse::Text {
            text: text.to_owned(),
        });
    }
    let parts: Vec<_> = content_parts(content)
        .filter(|part| part["type"] == "text")
        .filter_map(|part| part["text"].as_str())
        .collect();
    (!parts.is_empty()).then(|| AgentFinalResponse::Text {
        text: parts.join("\n\n"),
    })
}

#[derive(Clone, Copy, Debug)]
pub struct ConvertPiMessageOptions {
    pub include_tool_calls: bool,
    pub include_tool_results: bool,
    pub include_user: bool,
}

impl Default for ConvertPiMessageOptions {
    fn default() -> Self {
        Self {
            include_tool_calls: true,
            include_tool_results: true,
            include_user: true,
        }
    }
}

fn timestamp(value: &Value, clock: &dyn Clock) -> Result<String, InvalidTimeValue> {
    if let Some(time) = as_number(value).filter(|time| time.is_finite()) {
        return to_iso_string(time as i64);
    }
    let parsed = value
        .as_str()
        .filter(|text| !trim(text).is_empty())
        .and_then(date_parse);
    to_iso_string(parsed.unwrap_or_else(|| clock.now_ms()))
}

fn content_parts(content: &Value) -> impl Iterator<Item = &Value> {
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|part| part.is_object() && part["type"].is_string())
}

fn text_from_content(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return trim(text).to_owned();
    }
    content_parts(content)
        .filter(|part| part["type"] == "text")
        .filter_map(|part| part["text"].as_str())
        .map(trim)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn image_data_url(part: &Value) -> Option<String> {
    let data = part["data"].as_str().filter(|text| !text.is_empty())?;
    let mime_type = part["mimeType"].as_str().filter(|text| !text.is_empty())?;
    if data.starts_with("data:") {
        return Some(data.to_owned());
    }
    Some(format!("data:{mime_type};base64,{data}"))
}

fn images_from_content(content: &Value) -> Option<Vec<ChatImage>> {
    let images: Vec<_> = content_parts(content)
        .filter(|part| part["type"] == "image")
        .enumerate()
        .filter_map(|(index, part)| {
            Some(ChatImage {
                data: image_data_url(part)?,
                name: format!("image-{}", index + 1),
                mime_type: None,
            })
        })
        .collect();
    (!images.is_empty()).then_some(images)
}

fn assistant(timestamp: &str, content: &str) -> ChatMessage {
    ChatMessage::Assistant(AssistantMessage {
        timestamp: timestamp.to_owned(),
        content: content.to_owned(),
        questions: None,
    })
}

fn convert_assistant(
    timestamp: &str,
    content: &Value,
    options: ConvertPiMessageOptions,
) -> Vec<ChatMessage> {
    if let Some(text) = content.as_str() {
        let text = trim(text);
        return if text.is_empty() {
            Vec::new()
        } else {
            vec![assistant(timestamp, text)]
        };
    }
    content_parts(content)
        .filter_map(|part| match part["type"].as_str()? {
            "thinking" => {
                let thinking = part["thinking"]
                    .as_str()
                    .filter(|text| !trim(text).is_empty())?;
                Some(ChatMessage::Thinking(ThinkingMessage {
                    timestamp: timestamp.to_owned(),
                    content: thinking.to_owned(),
                }))
            }
            "text" => {
                let text = part["text"]
                    .as_str()
                    .filter(|text| !trim(text).is_empty())?;
                Some(assistant(timestamp, text))
            }
            "toolCall" if options.include_tool_calls => {
                let id = part["id"].as_str().unwrap_or_default();
                let name = part["name"]
                    .as_str()
                    .filter(|name| !name.is_empty())
                    .unwrap_or("Unknown");
                let arguments = part.get("arguments").cloned().map(Opaque::from_value);
                Some(ChatMessage::ToolUse(convert_pi_tool_use(
                    timestamp,
                    id,
                    name,
                    arguments.as_ref(),
                )))
            }
            _ => None,
        })
        .collect()
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::String(value) => !value.is_empty(),
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::Array(_) | Value::Object(_) => true,
    }
}

pub fn convert_pi_message(
    raw: &Value,
    options: ConvertPiMessageOptions,
    clock: &dyn Clock,
) -> Result<Vec<ChatMessage>, InvalidTimeValue> {
    if !raw.is_object() {
        return Ok(Vec::new());
    }
    let timestamp = timestamp(&raw["timestamp"], clock)?;
    let content = &raw["content"];
    Ok(match raw["role"].as_str() {
        Some("user") if options.include_user => {
            let text = text_from_content(content);
            let images = images_from_content(content);
            if text.is_empty() && images.is_none() {
                return Ok(Vec::new());
            }
            vec![ChatMessage::User(UserMessage {
                timestamp,
                content: strip_resolved_file_mention_context(&text).to_owned(),
                images,
                metadata: None,
                presentation: None,
            })]
        }
        Some("assistant") => convert_assistant(&timestamp, content, options),
        Some("toolResult") if options.include_tool_results => {
            let content = content.clone().into();
            vec![ChatMessage::ToolResult(ToolResultMessage::new(
                timestamp,
                raw["toolCallId"].as_str().unwrap_or_default().to_owned(),
                normalize_tool_result_content(Some(&content)),
                truthy(&raw["isError"]),
                None,
            ))]
        }
        _ => Vec::new(),
    })
}
